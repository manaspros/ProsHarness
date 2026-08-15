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
import { LocalGhStub, type GhClient, type GhCredential, type PrHandle, type DraftPrInput } from "@pros/implement";
import { runReconcile, parseReconcileArgs } from "../src/reconcile.js";

/**
 * Mirrors `LocalGhStub`'s pattern (backed by a real local bare git repo) but
 * with NO scope-based permission checks, matching `AmbientGhClient`'s real
 * behavior -- used to prove `pros reconcile`'s PR-ops step reaches the
 * zero-token ambient path when PROS_GH_PR_TOKEN is unset, fully offline.
 */
class LocalAmbientGhStub implements GhClient {
  private readonly prs = new Map<number, { number: number; url: string; headSha: string; branch: string }>();
  private nextNumber = 1;
  constructor(private readonly bareRepoPath: string) {}

  async createDraftPr(_cred: GhCredential, input: DraftPrInput): Promise<PrHandle> {
    const { stdout } = await execFileAsync("git", ["rev-parse", input.branch], { cwd: this.bareRepoPath });
    const headSha = stdout.trim();
    const number = this.nextNumber++;
    const url = `file://${this.bareRepoPath}/pull/${number}`;
    this.prs.set(number, { number, url, headSha, branch: input.branch });
    return { number, url, headSha };
  }
  async mergePr(): Promise<void> {
    throw new Error("LocalAmbientGhStub refuses to merge -- merging is exclusively a human action, never automated");
  }
  async commentOnPr(): Promise<void> {}
  async findPrForBranch(_cred: GhCredential, _repo: string, branch: string): Promise<PrHandle | undefined> {
    for (const record of this.prs.values()) {
      if (record.branch === branch) return { url: record.url, number: record.number, headSha: record.headSha };
    }
    return undefined;
  }
}

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

test("pros reconcile: PR-ops adopts a mid-flight intent via the ambient path when PROS_GH_PR_TOKEN is unset", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-ambient-runs-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-ambient-wt-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-ambient-leases-"));
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-reconcile-ambient-bare-"));
  const prevToken = process.env.PROS_GH_PR_TOKEN;
  try {
    delete process.env.PROS_GH_PR_TOKEN;

    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: bareRepoPath });
    const clone = await mkdtemp(path.join(tmpdir(), "pros-reconcile-ambient-clone-"));
    await execFileAsync("git", ["config", "--global", "init.defaultBranch", "main"]).catch(() => undefined);
    await execFileAsync("git", ["clone", "-q", bareRepoPath, clone]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: clone });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: clone });
    await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: clone });
    await execFileAsync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: clone });
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: clone });
    await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "feature work"], { cwd: clone });
    await execFileAsync("git", ["push", "-q", "origin", "feature"], { cwd: clone });
    await rm(clone, { recursive: true, force: true });

    const ghClient = new LocalAmbientGhStub(bareRepoPath);
    await ghClient.createDraftPr({ repo: "acme/widgets" }, { cwd: bareRepoPath, branch: "feature", baseBranch: "main", title: "t", body: "b" });

    const runId = "run-reconcile-ambient-1";
    const runDir = path.join(runsRoot, runId);
    const journal = await Journal.open(runDir);
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;
    await journal.append({
      runId,
      fenceEpoch,
      kind: "pr_create_intent",
      prIntentId: "intent-ambient-1",
      branch: "feature",
      baseBranch: "main",
      idempotencyKey: "pr-run-reconcile-ambient-1",
      repo: "acme/widgets",
    } as any);
    await journal.close();

    const args = parseReconcileArgs([], {
      PROS_RUNS_DIR: runsRoot,
      PROS_WORKTREES_DIR: worktreesRoot,
      PROS_LEASE_DIR: leaseDir,
    } as NodeJS.ProcessEnv);
    // ghClient injected explicitly -- this is the offline seam: production
    // code (no ghClient passed) would default to AmbientGhClient after a
    // real `checkGhAuthenticated()` preflight, which this test deliberately
    // does not exercise (that path is covered by the "not authenticated
    // anywhere" test below, and by pr.ts's own checkGhAuthenticated tests).
    const result = await runReconcile(args, ghClient);

    assert.ok(!("skipped" in result.prOps), `expected prOps to have run via the ambient path, got skipped: ${JSON.stringify(result.prOps)}`);
    if (!("skipped" in result.prOps)) {
      assert.deepEqual(result.prOps.adopted, ["intent-ambient-1"]);
      assert.deepEqual(result.prOps.needsManualRetry, []);
    }
  } finally {
    if (prevToken === undefined) delete process.env.PROS_GH_PR_TOKEN;
    else process.env.PROS_GH_PR_TOKEN = prevToken;
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros reconcile: with no PROS_GH_PR_TOKEN and no real gh auth (this machine's reality), PR-ops is skipped clearly, but worktree/lease recovery still completes", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-noauth-runs-"));
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-reconcile-noauth-wt-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-reconcile-noauth-leases-"));
  const prevToken = process.env.PROS_GH_PR_TOKEN;
  try {
    delete process.env.PROS_GH_PR_TOKEN;

    // Simulate a crash mid-worktree-allocation-saga, same as the first test
    // in this file -- this must still be recovered even though the PR-ops
    // step below is unavailable (no token, no real ambient gh session on
    // this machine either).
    const allocator = new WorktreeAllocator({ repoRoot: repo, worktreesRoot, runsRoot });
    await assert.rejects(() => allocator.allocate("run-noauth-1", { crashAfter: "act" }), AllocationCrashInjected);

    const args = parseReconcileArgs([], {
      PROS_RUNS_DIR: runsRoot,
      PROS_WORKTREES_DIR: worktreesRoot,
      PROS_LEASE_DIR: leaseDir,
    } as NodeJS.ProcessEnv);
    // No ghClient override passed -- exercises the real default-selection
    // logic, which (with no token set) attempts the real
    // checkGhAuthenticated() preflight against the real `gh` binary. The
    // critical, portability-independent invariant under test is that this
    // NEVER throws an unhandled error out of runReconcile -- worktree/lease
    // recovery must complete regardless of whether this dev machine happens
    // to have `gh` installed/authenticated or not.
    const result = await runReconcile(args);

    assert.equal(result.worktrees.finished.length, 1, "worktree recovery must still complete even though PR-ops is unavailable");
    // On this project's dev machine, `gh auth status` genuinely fails ("not
    // logged into any GitHub hosts"), so this must be reported as `skipped`
    // with a clear message, NOT thrown as an unhandled error out of
    // runReconcile (the fact that the `await` above didn't throw is itself
    // half of that invariant).
    assert.ok("skipped" in result.prOps, "expected prOps to be skipped since neither a token nor a real ambient gh session is available");
    if ("skipped" in result.prOps) {
      assert.ok(result.prOps.skipped.length > 0, "the skip reason must be a clear, non-empty message");
    }
  } finally {
    if (prevToken === undefined) delete process.env.PROS_GH_PR_TOKEN;
    else process.env.PROS_GH_PR_TOKEN = prevToken;
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
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
