import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier, Journal } from "@pros/barrier";
import { runPlanPipeline, type ModelSession, type ModelRunOptions, type ModelRunResult } from "@pros/plan";
import { WorktreeAllocator } from "@pros/worktree";
import { runGate2Pipeline } from "../src/pipeline.js";
import { LocalGhStub, GhPermissionError, type ScopedGhCredential } from "../src/pr.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** A minimal deterministic fake ModelSession -- one canned response per call, indexed by call order (mirrors packages/cli/test/plan.test.ts's FakeSession). */
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

/**
 * Gate 2's fake claude session: for the "-implement" attempt, actually fixes
 * the seeded off-by-one bug in the worktree, commits, and pushes its own
 * branch to origin -- exactly what `.claude/agents/implementer.md` instructs
 * a real scoped-fixer CLI session to do. For "-ultrareview" it returns a
 * clean (no-objections) review, matching runAdversarialReview's schema.
 */
class Gate2ClaudeSession implements ModelSession {
  readonly provider = "claude" as const;
  constructor(private readonly worktreePath: string) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    if (opts.attemptId.endsWith("-implement")) {
      await writeFile(path.join(this.worktreePath, "loop.ts"), "for (let i = 0; i < arr.length; i++) {}\n");
      await execFileAsync("git", ["add", "."], { cwd: this.worktreePath });
      await execFileAsync("git", ["commit", "-q", "-m", "fix off-by-one in loop bound"], { cwd: this.worktreePath });
      await execFileAsync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: this.worktreePath });
      return { text: "Fixed the off-by-one: loop bound is now exclusive.", usage: { inputTokens: 80, outputTokens: 60 } };
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

class PassingVerifierSession implements ModelSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return {
      text: JSON.stringify({ outcome: "pass", summary: "typecheck and tests pass", failingChecks: [] }),
      usage: { inputTokens: 15, outputTokens: 15 },
    };
  }
}

test("M4 end-to-end: seeded bug -> Gate 1 approval -> Gate 2 (implement/verify/review/draft PR) -> main untouched, worktree reaped, merge blocked", async () => {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-e2e-origin-"));
  const seedRepoRoot = await mkdtemp(path.join(tmpdir(), "pros-e2e-repo-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-e2e-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-e2e-runs-"));
  const runId = "e2e-m4-seeded-bug";

  try {
    // ---- Seed the bug in a real repo with a real "origin" remote ----
    // mkdtemp above already created bareRepoPath as an empty dir; `git init
    // --bare` into an existing empty directory is exactly what it expects.
    await execFileAsync("git", ["init", "-q", "-b", "main", "--bare", bareRepoPath]);

    // mkdtemp also already created seedRepoRoot as an empty dir; `git clone`
    // refuses to clone into a non-empty one but is fine with an existing
    // empty target, so clone straight into it rather than a subdirectory.
    await execFileAsync("git", ["clone", "-q", bareRepoPath, seedRepoRoot]);
    await git(seedRepoRoot, ["config", "user.email", "test@example.com"]);
    await git(seedRepoRoot, ["config", "user.name", "Test"]);
    await writeFile(path.join(seedRepoRoot, "loop.ts"), "for (let i = 0; i <= arr.length; i++) {}\n"); // the seeded off-by-one
    await git(seedRepoRoot, ["add", "."]);
    await git(seedRepoRoot, ["commit", "-q", "-m", "init with seeded off-by-one bug"]);
    await git(seedRepoRoot, ["push", "-q", "origin", "main"]);

    const mainShaBefore = await git(bareRepoPath, ["rev-parse", "main"]);

    // ---- Gate 1: finding -> plan -> Codex critique -> converge -> park ----
    const gate1Claude = new FakeSession("claude", [
      // finding
      JSON.stringify({
        title: "off-by-one in loop bound",
        evidence: [{ file: "loop.ts", line: 1, snippet: "for (let i = 0; i <= arr.length; i++) {}" }],
        summary: "loop bound is inclusive (<=) when it should be exclusive (<), reading past the end of arr",
      }),
      // draftPlan v1
      JSON.stringify({
        markdown: "# Plan\n\nChange the loop condition from `i <= arr.length` to `i < arr.length`.",
        structured: { steps: ["fix loop bound in loop.ts"], filesTouched: ["loop.ts"], risk: "low" },
      }),
    ]);
    const gate1Codex = new FakeSession("codex", [
      JSON.stringify({ approach: "fix the comparison operator", risks: ["none major"] }),
      JSON.stringify({ objections: [] }), // converge immediately, no debate needed
    ]);

    const gate1Result = await runPlanPipeline({
      repoRoot: seedRepoRoot,
      worktreesRoot,
      runsRoot,
      description: "arr[i] is undefined on the last element sometimes",
      runId,
      claudeSession: gate1Claude,
      codexSession: gate1Codex,
    });

    assert.ok(gate1Result.parked, "Gate 1 must have parked for approval");
    const runDir = path.join(runsRoot, runId);

    // Recover the allocated worktree's branch (not exposed on PlanPipelineResult -- read it back from the journal, same technique as packages/cli/test/plan.test.ts).
    const { entries: gate1Entries } = await Journal.read(runDir);
    const allocatedEntry = gate1Entries.find((e) => e.kind === "worktree_allocated") as
      | { branch: string; worktreePath: string; baseSha: string }
      | undefined;
    assert.ok(allocatedEntry, "expected a worktree_allocated journal entry");
    const branch = allocatedEntry!.branch;
    assert.equal(allocatedEntry!.worktreePath, gate1Result.worktreePath);

    // ---- Human approves Gate 1 (mirrors `pros answer <questionId> approve --effect=continue_within_approved_plan`) ----
    {
      const barrier = await Barrier.open(runDir, runId);
      try {
        const cp = barrier.getState().checkpoints.get(gate1Result.checkpointId)!;
        assert.equal(cp.gateType, "plan_approval");
        await barrier.recordAnswer(gate1Result.checkpointId, gate1Result.questionId, cp.idempotencyKey, "approve", "continue_within_approved_plan");
      } finally {
        await barrier.close();
      }
    }

    // ---- Gate 2: implement (Sonnet scoped-fixer) -> verify (background session) -> adversarial review -> draft PR -> park ----
    const ghClient = new LocalGhStub({ bareRepoPath });
    // The REAL recommended credential scope from packages/implement/src/pr.ts's
    // provisioning doc: Pull requests read/write, Contents READ-ONLY. No
    // merge capability.
    const ghCredential: ScopedGhCredential = {
      token: "test-scoped-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const gate2Result = await runGate2Pipeline({
      runId,
      runDir,
      worktreePath: gate1Result.worktreePath,
      branch,
      baseBranch: "main",
      repoRoot: REPO_ROOT, // for loading the real .claude/agents + .claude/skills briefs
      worktreeParentRepo: seedRepoRoot, // the worktree's actual originating repo, for `git worktree remove`
      reapWorktreeOnSuccess: true,
      planMarkdown: gate1Result.debate.finalPlan.markdown,
      fileAllowlist: ["loop.ts"],
      claudeSession: new Gate2ClaudeSession(gate1Result.worktreePath),
      codexSession: new CleanCodexReviewSession(),
      verifierSession: new PassingVerifierSession(),
      ghClient,
      ghCredential,
    });

    // ---- Assertions: the fix landed, on a branch, in a worktree ----
    assert.ok(gate2Result.implementResult.committed, "the implementation stage must have produced a real commit");
    assert.equal(gate2Result.verdict.outcome, "pass");
    assert.equal(gate2Result.review.verdict, "approve");
    assert.ok(gate2Result.pr, "a draft PR must have been opened");
    assert.ok(gate2Result.checkpointId && gate2Result.questionId, "Gate 2 must have parked with a checkpoint/question id");

    // The fix is real, pushed, and visible on the branch at origin -- fetch a
    // fresh clone and check the file content directly (never trust the
    // worktree, which we're about to prove is gone).
    const verifyClone = await mkdtemp(path.join(tmpdir(), "pros-e2e-verify-clone-"));
    await execFileAsync("git", ["clone", "-q", "-b", branch, bareRepoPath, verifyClone]);
    const fixedContent = await execFileAsync("cat", [path.join(verifyClone, "loop.ts")]).then((r) => r.stdout);
    assert.equal(fixedContent, "for (let i = 0; i < arr.length; i++) {}\n", "the fix must be present on the pushed branch");
    await rm(verifyClone, { recursive: true, force: true });

    // ---- main is completely untouched ----
    const mainShaAfter = await git(bareRepoPath, ["rev-parse", "main"]);
    assert.equal(mainShaAfter, mainShaBefore, "main must be byte-for-byte unchanged -- the system never merges");

    // ---- the worktree is reaped ----
    assert.equal(gate2Result.worktreeReaped, true, `expected the worktree to be reaped; error: ${gate2Result.worktreeReapError}`);
    await assert.rejects(() => stat(gate1Result.worktreePath), /ENOENT/, "the worktree directory must no longer exist on disk");
    const gitWorktreeList = await git(seedRepoRoot, ["worktree", "list", "--porcelain"]);
    assert.ok(!gitWorktreeList.includes(gate1Result.worktreePath), "git itself must no longer track the reaped worktree");

    // A post-hoc reconcile() over the same runsRoot/worktreesRoot must NOT
    // flag this (already-confirmed, deliberately-reaped) allocation as an
    // orphan needing rollback -- it was reaped on purpose, with its work
    // already safely pushed+PR'd, not abandoned mid-flight.
    const allocator = new WorktreeAllocator({ repoRoot: seedRepoRoot, worktreesRoot, runsRoot });
    const reconcileReport = await allocator.reconcile();
    assert.deepEqual(reconcileReport.finished, []);
    assert.deepEqual(reconcileReport.rolledBack, []);
    assert.ok(reconcileReport.alreadyOk.length >= 1, "the confirmed allocation must be reported already-ok, not rolled back");

    // ---- merge is blocked by the credential boundary, not a wrapper or a prompt ----
    await assert.rejects(
      () => ghClient.mergePr(ghCredential, gate2Result.pr!),
      GhPermissionError,
      "the SAME credential used to open the draft PR must be structurally unable to merge it",
    );
    const mainShaAfterMergeAttempt = await git(bareRepoPath, ["rev-parse", "main"]);
    assert.equal(mainShaAfterMergeAttempt, mainShaBefore, "the rejected merge attempt must leave main untouched at the git data layer");
  } finally {
    await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(seedRepoRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
