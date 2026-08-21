import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Barrier, Journal, loadRunState } from "@pros/barrier";
import { runPlanPipeline, type ModelSession, type ModelRunOptions, type ModelRunResult } from "@pros/plan";
import { LocalGhStub, type ScopedGhCredential } from "@pros/implement";
import { makeGate1ContinuationJob } from "../src/jobs.js";

/** ProsHarness's own repo root -- packages/schedule/test -> ../../.. -> repo root, same technique as packages/implement/test/helpers.ts. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

class FakeSession implements ModelSession {
  private i = 0;
  constructor(
    readonly provider: "claude" | "codex",
    private readonly responses: string[],
  ) {}
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    const text = this.responses[Math.min(this.i, this.responses.length - 1)]!;
    this.i += 1;
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

/** Mirrors packages/implement/test/e2e-m4.test.ts's Gate2ClaudeSession: makes and pushes a real commit for "-implement", and a clean review for "-ultrareview". */
class Gate2ClaudeSession implements ModelSession {
  readonly provider = "claude" as const;
  constructor(private readonly worktreePath: string) {}
  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    if (opts.attemptId.endsWith("-implement")) {
      await writeFile(path.join(this.worktreePath, "widget.ts"), "export const widget = 2;\n");
      await execFileAsync("git", ["add", "."], { cwd: this.worktreePath });
      await execFileAsync("git", ["commit", "-q", "-m", "bump widget"], { cwd: this.worktreePath });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: this.worktreePath });
      return { text: "bumped widget", usage: { inputTokens: 80, outputTokens: 60 } };
    }
    if (opts.attemptId.endsWith("-ultrareview")) {
      return { text: JSON.stringify({ objections: [] }), usage: { inputTokens: 20, outputTokens: 20 } };
    }
    throw new Error(`Gate2ClaudeSession: unexpected attemptId ${opts.attemptId}`);
  }
}

class CleanCodexReviewSession implements ModelSession {
  readonly provider = "codex" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ objections: [] }), usage: { inputTokens: 20, outputTokens: 20 } };
  }
}

/** Advisory-only post-Phase-3: outcome is derived from the harness-run `validationCommands` override passed to runGate2Pipeline (via gate2OptionsOverride) below, not from this session's text. */
class PassingVerifierSession implements ModelSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return {
      text: JSON.stringify({ summary: "typecheck and tests pass" }),
      usage: { inputTokens: 15, outputTokens: 15 },
    };
  }
}

async function runGate1ToApproval(opts: { runsRoot: string; worktreesRoot: string; runId: string }) {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-g1c-origin-"));
  const seedRepoRoot = await mkdtemp(path.join(tmpdir(), "pros-g1c-repo-"));

  await execFileAsync("git", ["init", "-q", "-b", "main", "--bare", bareRepoPath]);
  await execFileAsync("git", ["clone", "-q", bareRepoPath, seedRepoRoot]);
  await git(seedRepoRoot, ["config", "user.email", "test@example.com"]);
  await git(seedRepoRoot, ["config", "user.name", "Test"]);
  await writeFile(path.join(seedRepoRoot, "widget.ts"), "export const widget = 1;\n");
  await git(seedRepoRoot, ["add", "."]);
  await git(seedRepoRoot, ["commit", "-q", "-m", "init"]);
  await git(seedRepoRoot, ["push", "-q", "origin", "main"]);

  const claude = new FakeSession("claude", [
    JSON.stringify({
      title: "widget needs bumping",
      evidence: [{ file: "widget.ts", line: 1, snippet: "export const widget = 1;" }],
      summary: "widget should be 2",
    }),
    JSON.stringify({
      markdown: "# Plan\n\nBump widget from 1 to 2.",
      structured: { steps: ["bump widget"], filesTouched: ["widget.ts"], risk: "low" },
    }),
  ]);
  const codex = new FakeSession("codex", [
    JSON.stringify({ approach: "bump the constant", risks: [] }),
    JSON.stringify({ objections: [] }),
  ]);

  const result = await runPlanPipeline({
    repoRoot: seedRepoRoot,
    worktreesRoot: opts.worktreesRoot,
    runsRoot: opts.runsRoot,
    description: "widget is stale",
    runId: opts.runId,
    claudeSession: claude,
    codexSession: codex,
  });

  const runDir = path.join(opts.runsRoot, opts.runId);
  return { bareRepoPath, seedRepoRoot, runDir, result };
}

test("makeGate1ContinuationJob: an approved-but-unstarted Gate 1 run is continued through Gate 2 -> draft PR opened", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-g1c-wt-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-g1c-runs-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-g1c-lease-"));
  const runId = "g1c-happy-path";
  let bareRepoPath: string | undefined;
  let seedRepoRoot: string | undefined;

  try {
    const seeded = await runGate1ToApproval({ runsRoot, worktreesRoot, runId });
    bareRepoPath = seeded.bareRepoPath;
    seedRepoRoot = seeded.seedRepoRoot;

    // Human approves Gate 1, exactly like `pros answer <questionId> approve --effect=continue_within_approved_plan`.
    {
      const barrier = await Barrier.open(seeded.runDir, runId);
      try {
        const cp = barrier.getState().checkpoints.get(seeded.result.checkpointId)!;
        assert.equal(cp.gateType, "plan_approval");
        await barrier.recordAnswer(seeded.result.checkpointId, seeded.result.questionId, cp.idempotencyKey, "approve", "continue_within_approved_plan");
      } finally {
        await barrier.close();
      }
    }

    const ghClient = new LocalGhStub({ bareRepoPath });
    const ghCredential: ScopedGhCredential = {
      token: "test-scoped-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const job = makeGate1ContinuationJob({
      runsRoot,
      repoRoot: REPO_ROOT,
      leaseDir,
      maxConcurrent: 3,
      maxTokensPerRun: 200_000,
      gate2OptionsOverride: {
        claudeSession: new Gate2ClaudeSession(seeded.result.worktreePath),
        codexSession: new CleanCodexReviewSession(),
        verifierSession: new PassingVerifierSession(),
        ghClient,
        ghCredential,
        worktreeParentRepo: seedRepoRoot,
        // seedRepoRoot is an ad-hoc test repo with no real build/test suite --
        // override rather than relying on the ProsHarness-typecheck/test
        // fallback, which would spawn real `pnpm run typecheck` against a repo
        // with no package.json at all.
        validationCommands: [{ command: "exit 0", label: "checks" }],
      },
    });

    const summary = await job.run();
    assert.deepEqual(summary, { continued: 1, skippedStale: 0, skippedAlreadyStarted: 0, failures: 0, failureRunIds: [] });

    // Gate 2 actually ran: a Gate 2 (pr_review) checkpoint now exists, parked.
    const state = await loadRunState(seeded.runDir);
    const gate2Checkpoint = [...state.checkpoints.values()].find((cp) => cp.gateType === "pr_review");
    assert.ok(gate2Checkpoint, "expected a pr_review checkpoint to have been created");
    assert.equal(gate2Checkpoint!.phase, "parked");
    assert.ok(gate2Checkpoint!.prRef?.url, "expected the checkpoint to carry the opened PR's url");

    // Re-running the job immediately must be a no-op (idempotent across ticks) -- skippedAlreadyStarted, not a second Gate 2 run.
    const secondSummary = await job.run();
    assert.deepEqual(secondSummary, { continued: 0, skippedStale: 0, skippedAlreadyStarted: 1, failures: 0, failureRunIds: [] });
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("makeGate1ContinuationJob: stale/superseded approval (fence bumped after this checkpoint's approval was recorded) is skipped, not continued", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-g1c-wt2-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-g1c-runs2-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-g1c-lease2-"));
  const runId = "g1c-stale";
  let bareRepoPath: string | undefined;
  let seedRepoRoot: string | undefined;

  try {
    const seeded = await runGate1ToApproval({ runsRoot, worktreesRoot, runId });
    bareRepoPath = seeded.bareRepoPath;
    seedRepoRoot = seeded.seedRepoRoot;

    // Approve Gate 1 normally first.
    const barrier = await Barrier.open(seeded.runDir, runId);
    let idempotencyKey: string;
    try {
      const cp = barrier.getState().checkpoints.get(seeded.result.checkpointId)!;
      idempotencyKey = cp.idempotencyKey;
      await barrier.recordAnswer(seeded.result.checkpointId, seeded.result.questionId, idempotencyKey, "approve", "continue_within_approved_plan");
    } finally {
      await barrier.close();
    }

    // Construct the exact race the guard exists to catch: this project's own
    // `recordAnswer` throws `StaleAnswerError` on a SECOND call against a
    // checkpoint whose in-memory `Barrier` state already reflects the first
    // answer (phase !== "parked"). A genuine two-process race would need two
    // independent `Barrier.open()` instances racing each other with stale
    // in-memory snapshots, which isn't reproducible through the public API
    // without reaching into private state (see this test's second half of
    // the doc comment). What CAN be constructed through the public API is
    // the observable SIDE EFFECT of that race: a `fence_bumped` journal
    // entry landing after the checkpoint's own `checkpoint_requested`
    // fenceEpoch was recorded, without changing the (already-first-wins)
    // projected `answered` effect. So this test appends that entry directly
    // via `Journal` -- the same durable primitive `Barrier`/`Fence` write
    // through -- to reproduce the POST-CONDITION a raced amendment/abort
    // would leave behind, and asserts the continuation job's guard reacts
    // to it correctly. This is a faithful test of the guard's actual
    // comparison logic (checkpoint's recorded fenceEpoch vs. current
    // fenceEpoch), even though the two-process race that would organically
    // produce this state is not itself exercised here.
    const journal = await Journal.open(seeded.runDir);
    try {
      await journal.append({
        runId,
        fenceEpoch: 0,
        kind: "fence_bumped",
        previousEpoch: 0,
        newEpoch: 1,
        reason: "test: simulated raced requires_plan_amendment answer on a duplicate checkpoint",
      });
    } finally {
      await journal.close();
    }

    const ghClient = new LocalGhStub({ bareRepoPath });
    const ghCredential: ScopedGhCredential = {
      token: "test-scoped-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const job = makeGate1ContinuationJob({
      runsRoot,
      repoRoot: REPO_ROOT,
      leaseDir,
      maxConcurrent: 3,
      maxTokensPerRun: 200_000,
      gate2OptionsOverride: {
        claudeSession: new Gate2ClaudeSession(seeded.result.worktreePath),
        codexSession: new CleanCodexReviewSession(),
        verifierSession: new PassingVerifierSession(),
        ghClient,
        ghCredential,
        worktreeParentRepo: seedRepoRoot,
        // seedRepoRoot is an ad-hoc test repo with no real build/test suite --
        // override rather than relying on the ProsHarness-typecheck/test
        // fallback, which would spawn real `pnpm run typecheck` against a repo
        // with no package.json at all.
        validationCommands: [{ command: "exit 0", label: "checks" }],
      },
    });

    const summary = await job.run();
    assert.deepEqual(summary, { continued: 0, skippedStale: 1, skippedAlreadyStarted: 0, failures: 0, failureRunIds: [] });

    // Gate 2 must NOT have run: no pr_review checkpoint, no PR opened.
    const state = await loadRunState(seeded.runDir);
    const gate2Checkpoint = [...state.checkpoints.values()].find((cp) => cp.gateType === "pr_review");
    assert.equal(gate2Checkpoint, undefined, "Gate 2 must not have been triggered for a stale/superseded approval");
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
