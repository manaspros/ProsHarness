import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFreshBaseRef, FreshBaseResolutionError } from "../src/fresh-base.js";
import { WorktreeAllocator } from "../src/allocator.js";
import { git } from "./helpers.js";

const execFileAsync = promisify(execFile);

/**
 * These tests exercise `resolveFreshBaseRef` against REAL git repositories
 * and a REAL local bare "remote" -- no mocking git, per the M1 lesson
 * (packages/worktree/test/allocator.test.ts's own doc comment). A bare repo
 * on disk is a real git remote as far as `git fetch`/`git clone` are
 * concerned; no network is needed to exercise fetch success, fetch failure,
 * or default-branch detection.
 */

async function initBareRepoWithBranch(defaultBranch: string): Promise<{ bareRepoPath: string; seedRepoRoot: string }> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-fb-origin-"));
  const seedRepoRoot = await mkdtemp(path.join(tmpdir(), "pros-fb-seed-"));
  await execFileAsync("git", ["init", "-q", "-b", defaultBranch, "--bare", bareRepoPath]);
  await execFileAsync("git", ["clone", "-q", bareRepoPath, seedRepoRoot]);
  await git(seedRepoRoot, ["config", "user.email", "test@example.com"]);
  await git(seedRepoRoot, ["config", "user.name", "Test"]);
  await writeFile(path.join(seedRepoRoot, "README.md"), "hello\n");
  await git(seedRepoRoot, ["add", "."]);
  await git(seedRepoRoot, ["commit", "-q", "-m", "init"]);
  await git(seedRepoRoot, ["push", "-q", "origin", defaultBranch]);
  return { bareRepoPath, seedRepoRoot };
}

async function cloneLocal(bareRepoPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-fb-clone-"));
  await execFileAsync("git", ["clone", "-q", bareRepoPath, dir]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  return dir;
}

async function rmAll(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { recursive: true, force: true }).catch(() => undefined)));
}

test("resolves the remote default branch (main) and picks up a commit the local clone never pulled", async () => {
  const { bareRepoPath, seedRepoRoot } = await initBareRepoWithBranch("main");
  const localClone = await cloneLocal(bareRepoPath);
  try {
    // Someone else pushes directly to the bare "remote" -- the local clone
    // never runs `git pull`/`git fetch` itself.
    await writeFile(path.join(seedRepoRoot, "new-file.txt"), "fresh upstream work\n");
    await git(seedRepoRoot, ["add", "."]);
    await git(seedRepoRoot, ["commit", "-q", "-m", "upstream commit the clone has not seen"]);
    await git(seedRepoRoot, ["push", "-q", "origin", "main"]);
    const upstreamSha = (await git(bareRepoPath, ["rev-parse", "main"])).trim();

    const localHeadBefore = (await git(localClone, ["rev-parse", "HEAD"])).trim();
    assert.notEqual(localHeadBefore, upstreamSha, "sanity: the local clone must actually be behind before resolving");

    const result = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin" });

    assert.equal(result.remote, "origin");
    assert.equal(result.defaultBranch, "main");
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.fetchOk, true);
    assert.equal(result.usedStaleRemoteRef, false);

    const resolvedSha = (await git(localClone, ["rev-parse", result.baseRef])).trim();
    assert.equal(resolvedSha, upstreamSha, "resolveFreshBaseRef must reflect the REMOTE tip, not the stale local clone");

    // The local clone's own checked-out branch must be untouched -- fetch,
    // never pull/merge/checkout.
    const localHeadAfter = (await git(localClone, ["rev-parse", "HEAD"])).trim();
    assert.equal(localHeadAfter, localHeadBefore, "resolveFreshBaseRef must never mutate the local branch");
  } finally {
    await rmAll(bareRepoPath, seedRepoRoot, localClone);
  }
});

test("resolves the remote default branch when it is master, not main -- never assumes main", async () => {
  const { bareRepoPath } = await initBareRepoWithBranch("master");
  const localClone = await cloneLocal(bareRepoPath);
  try {
    const result = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin" });
    assert.equal(result.defaultBranch, "master");
    assert.equal(result.baseRef, "origin/master");
  } finally {
    await rmAll(bareRepoPath, localClone);
  }
});

test("fetch failure with a pre-existing remote-tracking ref: proceeds on the stale ref, loudly flagged, never silently fresh", async () => {
  const { bareRepoPath } = await initBareRepoWithBranch("main");
  const localClone = await cloneLocal(bareRepoPath);
  try {
    const staleSha = (await git(localClone, ["rev-parse", "origin/main"])).trim();

    // Break the remote AFTER the clone has a real refs/remotes/origin/main --
    // simulates "no network" / "remote briefly unreachable", not "never
    // cloned at all".
    await git(localClone, ["remote", "set-url", "origin", path.join(tmpdir(), "definitely-does-not-exist-" + Date.now())]);

    const result = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin" });
    assert.equal(result.fetchOk, false, "fetch against a broken remote must be reported as failed");
    assert.equal(result.usedStaleRemoteRef, true);
    assert.ok(result.detail, "the fetch failure detail must be recorded, not swallowed");
    assert.equal(result.baseRef, "origin/main");
    assert.equal((await git(localClone, ["rev-parse", result.baseRef])).trim(), staleSha);
  } finally {
    await rmAll(bareRepoPath, localClone);
  }
});

test("no remote at all: hard-fails rather than silently basing the workspace on local HEAD", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-fb-noremote-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test"]);
    await writeFile(path.join(dir, "f.txt"), "x\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-q", "-m", "init"]);

    await assert.rejects(() => resolveFreshBaseRef({ repoRoot: dir, remote: "origin" }), FreshBaseResolutionError);
  } finally {
    await rmAll(dir);
  }
});

test("default-branch fallback: used when both symbolic-ref and remote show cannot resolve it (remote unreachable, local HEAD ref deleted)", async () => {
  const { bareRepoPath } = await initBareRepoWithBranch("trunk");
  const localClone = await cloneLocal(bareRepoPath);
  try {
    await execFileAsync("git", ["remote", "set-head", "--delete", "origin"], { cwd: localClone }).catch(() => undefined);
    await git(localClone, ["remote", "set-url", "origin", path.join(tmpdir(), "definitely-does-not-exist-" + Date.now())]);

    const result = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin", defaultBranchFallback: "trunk" });
    assert.equal(result.defaultBranch, "trunk");
    assert.equal(result.baseRef, "origin/trunk");
    assert.equal(result.fetchOk, false);
    assert.equal(result.usedStaleRemoteRef, true);
  } finally {
    await rmAll(bareRepoPath, localClone);
  }
});

test("REGRESSION (the observed incident): an uncommitted edit in the parent repo does NOT appear in a workspace allocated from a fresh remote base ref", async () => {
  const { bareRepoPath } = await initBareRepoWithBranch("main");
  const localClone = await cloneLocal(bareRepoPath);
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fb-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fb-runs-"));
  try {
    // The exact hazard from the incident: uncommitted, un-staged "working-tree
    // instrumentation" sitting in the parent repo the model must never read
    // as if it were candidate-branch truth.
    await writeFile(path.join(localClone, "README.md"), "UNCOMMITTED local instrumentation, never pushed\n");

    const resolved = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin" });
    const allocator = new WorktreeAllocator({ repoRoot: localClone, worktreesRoot, runsRoot });
    const allocation = await allocator.allocate("run-leak-regression", { baseRef: resolved.baseRef });

    const workspaceReadme = await (await import("node:fs/promises")).readFile(path.join(allocation.path, "README.md"), "utf8");
    assert.equal(workspaceReadme, "hello\n", "the workspace must reflect the committed remote content, never the parent's uncommitted edit");
    assert.notEqual(workspaceReadme, "UNCOMMITTED local instrumentation, never pushed\n");
  } finally {
    await rmAll(bareRepoPath, localClone, worktreesRoot, runsRoot);
  }
});

test("two sessions from the same repo get independent, non-colliding fresh workspaces", async () => {
  const { bareRepoPath } = await initBareRepoWithBranch("main");
  const localClone = await cloneLocal(bareRepoPath);
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-fb-worktrees2-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-fb-runs2-"));
  try {
    const resolved = await resolveFreshBaseRef({ repoRoot: localClone, remote: "origin" });
    const allocator = new WorktreeAllocator({ repoRoot: localClone, worktreesRoot, runsRoot });
    const a = await allocator.allocate("run-collide-a", { baseRef: resolved.baseRef });
    const b = await allocator.allocate("run-collide-b", { baseRef: resolved.baseRef });

    assert.notEqual(a.path, b.path);
    assert.notEqual(a.branch, b.branch);
    await writeFile(path.join(a.path, "a-only.txt"), "a\n");
    const bHasA = await (await import("node:fs/promises")).stat(path.join(b.path, "a-only.txt")).then(() => true, () => false);
    assert.equal(bHasA, false, "two sessions on the same repo must not share a workspace");
  } finally {
    await rmAll(bareRepoPath, localClone, worktreesRoot, runsRoot);
  }
});
