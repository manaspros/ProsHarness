import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeAllocator, AllocationCrashInjected } from "@pros/worktree";
import { ConcurrencyLease } from "@pros/lease";
import { Journal, loadRunState } from "@pros/barrier";
import { LocalGhStub } from "@pros/implement";
import { runReconcile, parseReconcileArgs } from "../src/reconcile.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("pros reconcile: adopts a mid-flight worktree allocation and frees a stale lease", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-runs-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-wt-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-leases-"));

  try {
    // Simulate a crash mid-worktree-allocation-saga (crash right after `git worktree add` succeeded).
    const allocator = new WorktreeAllocator({ repoRoot: repo, worktreesRoot, runsRoot });
    const runId = "run-reconcile-1";
    await assert.rejects(() => allocator.allocate(runId, { crashAfter: "act" }), AllocationCrashInjected);

    // Simulate a crashed run that never released its concurrency lease and
    // whose heartbeat has clearly gone stale (staleAfterMs: 1ms + a real wait).
    const staleLease = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 5, runId: "run-crashed", staleAfterMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    void staleLease; // never released, never heartbeated again -- exactly the crash scenario

    const args = parseReconcileArgs(["--stale-after=1"], {
      PROS_RUNS_DIR: runsRoot,
      PROS_WORKTREES_DIR: worktreesRoot,
      PROS_LEASE_DIR: leaseDir,
    } as NodeJS.ProcessEnv);
    const result = await runReconcile(args);

    assert.equal(result.worktrees.finished.length, 1, "the mid-flight worktree allocation should be adopted, not destroyed");
    assert.deepEqual(result.leasesFreed, ["run-crashed"]);

    // A fresh acquire for a NEW run now succeeds because the stale lease was freed.
    const fresh = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: "run-fresh", staleAfterMs: 60_000 });
    await fresh.release();
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros reconcile: adopts a mid-flight PR-create intent whose PR actually exists", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-pr-runs-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-pr-wt-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-pr-leases-"));
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-reconcile-pr-bare-"));
  const prevToken = process.env.PROS_GH_PR_TOKEN;
  const prevScopes = process.env.PROS_GH_PR_SCOPES;
  try {
    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: bareRepoPath });
    const clone = await mkdtemp(path.join(tmpdir(), "pros-reconcile-pr-clone-"));
    await execFileAsync("git", ["clone", "-q", bareRepoPath, clone]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: clone });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: clone });
    await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: clone });
    await execFileAsync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: clone });
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: clone });
    await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "feature work"], { cwd: clone });
    await execFileAsync("git", ["push", "-q", "origin", "feature"], { cwd: clone });
    await rm(clone, { recursive: true, force: true });

    process.env.PROS_GH_PR_TOKEN = "test-token";
    process.env.PROS_GH_PR_SCOPES = "pull_requests:write,contents:read,metadata:read";

    const ghClient = new LocalGhStub({ bareRepoPath });
    const cred = { token: "test-token", scopes: new Set(["pull_requests:write" as const]), repo: "acme/widgets" };
    const pr = await ghClient.createDraftPr(cred, {
      cwd: clone,
      branch: "feature",
      baseBranch: "main",
      title: "t",
      body: "b",
    });

    const runId = "run-reconcile-pr-1";
    const runDir = path.join(runsRoot, runId);
    const journal = await Journal.open(runDir);
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;
    await journal.append({
      runId,
      fenceEpoch,
      kind: "pr_create_intent",
      prIntentId: "intent-1",
      branch: "feature",
      baseBranch: "main",
      idempotencyKey: "pr-run-reconcile-pr-1",
      repo: "acme/widgets",
    } as any);
    await journal.close();

    const args = parseReconcileArgs([], {
      PROS_RUNS_DIR: runsRoot,
      PROS_WORKTREES_DIR: worktreesRoot,
      PROS_LEASE_DIR: leaseDir,
    } as NodeJS.ProcessEnv);
    const result = await runReconcile(args, ghClient);

    assert.ok(!("skipped" in result.prOps), `expected prOps to have run, got skipped: ${JSON.stringify(result.prOps)}`);
    if (!("skipped" in result.prOps)) {
      assert.deepEqual(result.prOps.adopted, ["intent-1"]);
      assert.deepEqual(result.prOps.needsManualRetry, []);
    }
    void pr;
  } finally {
    process.env.PROS_GH_PR_TOKEN = prevToken;
    process.env.PROS_GH_PR_SCOPES = prevScopes;
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros reconcile: a run with no journal at all is simply skipped, not an error", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-empty-runs-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-empty-wt-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-empty-leases-"));
  try {
    const args = parseReconcileArgs([], {
      PROS_RUNS_DIR: runsRoot,
      PROS_WORKTREES_DIR: worktreesRoot,
      PROS_LEASE_DIR: leaseDir,
    } as NodeJS.ProcessEnv);
    const result = await runReconcile(args);
    assert.deepEqual(result.worktrees.finished, []);
    assert.deepEqual(result.worktrees.rolledBack, []);
    assert.deepEqual(result.leasesFreed, []);
    // leaseDir directory itself should still exist / not throw on stat
    await stat(leaseDir);
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
