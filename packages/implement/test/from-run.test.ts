import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runPlanPipeline, type ModelSession, type ModelRunOptions, type ModelRunResult } from "@pros/plan";
import { Journal } from "@pros/barrier";
import { deriveGate2OptionsFromRun, isGate2AlreadyStarted } from "../src/from-run.js";
import { buildPrContent } from "../src/pipeline.js";
import { runVerification, type Verdict } from "../src/verify.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Mirrors e2e-m4.test.ts's FakeSession -- one canned response per call, indexed by call order. */
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

class SummarySession implements ModelSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ summary: "ok" }), usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** Same pattern as pr-content.test.ts's makeVerdict -- Verdict is unconstructible outside verify.ts's brand. */
async function makeVerdict(runDir: string): Promise<Verdict> {
  return runVerification({
    verifierSession: new SummarySession(),
    worktreePath: process.cwd(),
    runId: "verdict-run",
    runDir,
    expectedFenceEpoch: 0,
    attemptId: "verdict-run-verify",
    validationCommands: [{ command: "exit 0", label: "check-a" }],
  });
}

async function seedRepoAndRunGate1(opts: {
  runsRoot: string;
  worktreesRoot: string;
  runId: string;
  planStructured: Record<string, unknown>;
}): Promise<{ seedRepoRoot: string; bareRepoPath: string; runDir: string; result: Awaited<ReturnType<typeof runPlanPipeline>> }> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-fromrun-origin-"));
  const seedRepoRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-repo-"));

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
      title: "finding",
      evidence: [{ file: "widget.ts", line: 1, snippet: "export const widget = 1;" }],
      summary: "a finding",
    }),
    JSON.stringify({
      markdown: "# Plan\n\nDo the thing.",
      structured: opts.planStructured,
    }),
  ]);
  const codex = new FakeSession("codex", [
    JSON.stringify({ approach: "approach", risks: [] }),
    JSON.stringify({ objections: [] }), // converge immediately
  ]);

  const result = await runPlanPipeline({
    repoRoot: seedRepoRoot,
    worktreesRoot: opts.worktreesRoot,
    runsRoot: opts.runsRoot,
    description: "a task",
    runId: opts.runId,
    claudeSession: claude,
    codexSession: codex,
  });

  const runDir = path.join(opts.runsRoot, opts.runId);
  return { seedRepoRoot, bareRepoPath, runDir, result };
}

test("deriveGate2OptionsFromRun: normal case -- worktreePath/branch/baseBranch/planMarkdown/fileAllowlist all derived correctly", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-wt-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-runs-"));
  const runId = "from-run-normal";
  let seedRepoRoot: string | undefined;
  let bareRepoPath: string | undefined;

  try {
    const seeded = await seedRepoAndRunGate1({
      runsRoot,
      worktreesRoot,
      runId,
      planStructured: { steps: ["do the thing"], filesTouched: ["widget.ts"], risk: "low" },
    });
    seedRepoRoot = seeded.seedRepoRoot;
    bareRepoPath = seeded.bareRepoPath;

    const opts = await deriveGate2OptionsFromRun({
      runsRoot,
      runId,
      repoRoot: REPO_ROOT,
    });

    assert.equal(opts.runId, runId);
    assert.equal(opts.runDir, seeded.runDir);
    assert.equal(opts.worktreePath, seeded.result.worktreePath);
    assert.equal(opts.worktreeParentRepo, seedRepoRoot);
    assert.equal(opts.baseBranch, "main");
    assert.equal(opts.repoRoot, REPO_ROOT);
    assert.deepEqual(opts.fileAllowlist, ["widget.ts"]);
    assert.equal(opts.planMarkdown, seeded.result.debate.finalPlan.markdown);
    assert.match(opts.branch, /^pros\//);

    assert.equal(await isGate2AlreadyStarted(seeded.runDir), false);
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deriveGate2OptionsFromRun: missing plan_finalized -> throws a clear error", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-nofinal-"));
  const runId = "from-run-no-finalize";
  const runDir = path.join(runsRoot, runId);

  try {
    // A run directory with SOME journal history (a worktree allocation) but
    // no plan_finalized entry at all -- e.g. a crash mid-debate.
    const journal = await Journal.open(runDir);
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "worktree_intent",
      allocationId: "alloc-1",
      repoRoot: "/nonexistent/repo",
      worktreePath: "/nonexistent/worktree",
      branch: "pros/from-run-no-finalize/alloc-1",
    });
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "worktree_allocated",
      allocationId: "alloc-1",
      baseSha: "deadbeef",
      worktreePath: "/nonexistent/worktree",
      branch: "pros/from-run-no-finalize/alloc-1",
    });
    await journal.close();

    await assert.rejects(
      () => deriveGate2OptionsFromRun({ runsRoot, runId, repoRoot: REPO_ROOT }),
      /no plan_finalized journal entry found/,
    );
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deriveGate2OptionsFromRun: fileAllowlist falls back to [] when structured/filesTouched is missing or malformed", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-wt2-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-runs2-"));
  const runId = "from-run-no-allowlist";
  let seedRepoRoot: string | undefined;
  let bareRepoPath: string | undefined;

  try {
    // structured has no filesTouched field at all.
    const seeded = await seedRepoAndRunGate1({
      runsRoot,
      worktreesRoot,
      runId,
      planStructured: { steps: ["do the thing"], risk: "low" },
    });
    seedRepoRoot = seeded.seedRepoRoot;
    bareRepoPath = seeded.bareRepoPath;

    const opts = await deriveGate2OptionsFromRun({ runsRoot, runId, repoRoot: REPO_ROOT });
    assert.deepEqual(opts.fileAllowlist, []);
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deriveGate2OptionsFromRun: planClaim/planDiagram are wired from the journal's structured plan, and flow through buildPrContent into a real diagram+claim-derived PR", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-wt3-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-runs3-"));
  const runId = "from-run-claim-diagram";
  let seedRepoRoot: string | undefined;
  let bareRepoPath: string | undefined;

  try {
    const seeded = await seedRepoAndRunGate1({
      runsRoot,
      worktreesRoot,
      runId,
      planStructured: {
        steps: ["do the thing"],
        filesTouched: ["widget.ts"],
        risk: "low",
        claim: "Add retry to the flaky webhook call",
        diagram: "graph TD\nA-->B",
      },
    });
    seedRepoRoot = seeded.seedRepoRoot;
    bareRepoPath = seeded.bareRepoPath;

    // The real derivation path -- no hand-assembled Gate2PipelineOptions.
    const opts = await deriveGate2OptionsFromRun({ runsRoot, runId, repoRoot: REPO_ROOT });
    assert.equal(opts.planClaim, "Add retry to the flaky webhook call");
    assert.equal(opts.planDiagram, "graph TD\nA-->B");

    const verdict = await makeVerdict(seeded.runDir);
    const { title, body } = buildPrContent({
      runId,
      planClaim: opts.planClaim,
      planMarkdown: opts.planMarkdown,
      planDiagram: opts.planDiagram,
      verdict,
      codexAdvisory: undefined,
      unresolvedNonBlockers: [],
    });

    assert.match(title, /^add: /);
    assert.match(body, /## Diagram/);
    assert.match(body, /```mermaid\ngraph TD\nA-->B\n```/);
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deriveGate2OptionsFromRun: planClaim/planDiagram stay undefined for a plan finalized before the claim/diagram schema existed", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-wt4-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-runs4-"));
  const runId = "from-run-no-claim-diagram";
  let seedRepoRoot: string | undefined;
  let bareRepoPath: string | undefined;

  try {
    // No claim/diagram fields at all -- the pre-Phase-5a shape.
    const seeded = await seedRepoAndRunGate1({
      runsRoot,
      worktreesRoot,
      runId,
      planStructured: { steps: ["do the thing"], filesTouched: ["widget.ts"], risk: "low" },
    });
    seedRepoRoot = seeded.seedRepoRoot;
    bareRepoPath = seeded.bareRepoPath;

    const opts = await deriveGate2OptionsFromRun({ runsRoot, runId, repoRoot: REPO_ROOT });
    assert.equal(opts.planClaim, undefined);
    assert.equal(opts.planDiagram, undefined);
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("deriveGate2OptionsFromRun: a non-conforming planClaim (single word, no verb:object shape) flows through buildPrContent without throwing", async () => {
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-wt5-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fromrun-runs5-"));
  const runId = "from-run-bad-claim";
  let seedRepoRoot: string | undefined;
  let bareRepoPath: string | undefined;

  try {
    const seeded = await seedRepoAndRunGate1({
      runsRoot,
      worktreesRoot,
      runId,
      // A single word can never be reshaped into "verb: object" by
      // derivePrTitle -- this is exactly the shape that used to be able to
      // silently start throwing PrTitleValidationError once planClaim got
      // wired in. buildPrContent must fall back to planMarkdown instead.
      planStructured: { steps: ["do the thing"], filesTouched: ["widget.ts"], risk: "low", claim: "Done" },
    });
    seedRepoRoot = seeded.seedRepoRoot;
    bareRepoPath = seeded.bareRepoPath;

    const opts = await deriveGate2OptionsFromRun({ runsRoot, runId, repoRoot: REPO_ROOT });
    assert.equal(opts.planClaim, "Done");

    const verdict = await makeVerdict(seeded.runDir);
    // Must not throw PrTitleValidationError -- must fall back to planMarkdown's own words.
    const { title } = buildPrContent({
      runId,
      planClaim: opts.planClaim,
      planMarkdown: opts.planMarkdown,
      planDiagram: opts.planDiagram,
      verdict,
      codexAdvisory: undefined,
      unresolvedNonBlockers: [],
    });
    assert.match(title, /^[a-z][a-z0-9-]*: .+/);
  } finally {
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    if (seedRepoRoot) await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (bareRepoPath) await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});
