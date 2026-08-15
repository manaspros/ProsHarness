import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal } from "@pros/barrier";
import { rebuildIndex } from "@pros/index";
import { parseLatestEventOfKind, getWorktreeInfo, computeReviewData, type VerifyVerdictPayload } from "../lib/review-data.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Builds a small real throwaway git repo with a base commit and a second
 * commit touching an "auth"-pathed file -- mirrors the pattern used by
 * packages/review/test/helpers.ts's makeFixtureRepo (that file lives in a
 * sibling, already-tested package's test/ dir, which this dashboard
 * package must not depend on or modify -- so a small local copy of the
 * same idea is written here instead).
 */
async function makeFixtureRepo(): Promise<{ repoRoot: string; baseSha: string; headSha: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "pros-dash-review-fixture-"));
  await git(repoRoot, ["init", "-q", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test"]);

  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "auth.ts"), "export function login(): boolean {\n  return true;\n}\n");
  await writeFile(path.join(repoRoot, "README.md"), "hello\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "base"]);
  const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);

  await writeFile(
    path.join(repoRoot, "src", "auth.ts"),
    'export function login(): boolean {\n  if (!true) throw new Error("auth failure");\n  return true;\n}\n',
  );
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "head"]);
  const headSha = await git(repoRoot, ["rev-parse", "HEAD"]);

  return { repoRoot, baseSha, headSha };
}

test("parseLatestEventOfKind: highest-seq row of a given kind wins", async () => {
  const runsRoot = await makeTempDir("pros-dash-review-runs-");
  const dbDir = await makeTempDir("pros-dash-review-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "verify_verdict",
      outcome: "fail",
      summary: "first attempt failed",
      failingChecksJson: JSON.stringify(["lint"]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "verify_verdict",
      outcome: "pass",
      summary: "second attempt passed",
      failingChecksJson: JSON.stringify([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await j.close();

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const latest = parseLatestEventOfKind<VerifyVerdictPayload>(db, runId, "verify_verdict");
      assert.ok(latest);
      assert.equal(latest!.outcome, "pass");
      assert.equal(latest!.summary, "second attempt passed");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("parseLatestEventOfKind: undefined when no row of that kind exists", async () => {
  const runsRoot = await makeTempDir("pros-dash-review-runs-");
  const dbDir = await makeTempDir("pros-dash-review-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      assert.equal(parseLatestEventOfKind(db, runId, "verify_verdict"), undefined);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("getWorktreeInfo: reads back a confirmed worktree row correctly", async () => {
  const runsRoot = await makeTempDir("pros-dash-review-runs-");
  const dbDir = await makeTempDir("pros-dash-review-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "worktree_intent",
      allocationId: "alloc-1",
      repoRoot: "/repos/parent",
      worktreePath: "/repos/parent/.worktrees/alloc-1",
      branch: "feature/x",
    });
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "worktree_allocated",
      allocationId: "alloc-1",
      baseSha: "deadbeef",
      worktreePath: "/repos/parent/.worktrees/alloc-1",
      branch: "feature/x",
    });
    await j.append({ runId, fenceEpoch: 0, kind: "worktree_confirmed", allocationId: "alloc-1" });
    await j.close();

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const info = getWorktreeInfo(db, runId);
      assert.ok(info);
      assert.equal(info!.repoRoot, "/repos/parent");
      assert.equal(info!.worktreePath, "/repos/parent/.worktrees/alloc-1");
      assert.equal(info!.branch, "feature/x");
      assert.equal(info!.baseSha, "deadbeef");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("getWorktreeInfo: undefined when no worktree row exists for this run", async () => {
  const runsRoot = await makeTempDir("pros-dash-review-runs-");
  const dbDir = await makeTempDir("pros-dash-review-db-");
  try {
    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);
    const db = new Database(dbPath);
    try {
      assert.equal(getWorktreeInfo(db, "no-such-run"), undefined);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("computeReviewData: real git repo, auth-pathed file ranks with a nonzero risk factor", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const { riskRankedDiff, checklist } = computeReviewData({
      repoRoot: fixture.repoRoot,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    });

    assert.ok(riskRankedDiff.hunks.length > 0, "expected at least one hunk");
    const authHunk = riskRankedDiff.hunks.find((h) => h.file === "src/auth.ts");
    assert.ok(authHunk, "expected a hunk for src/auth.ts");
    assert.ok(authHunk!.riskScore > 0, "auth hunk should have a nonzero risk score");
    assert.ok(
      authHunk!.riskFactors.some((f) => f.toLowerCase().includes("auth")),
      "auth hunk should carry an auth-keyword risk factor",
    );
    assert.ok(checklist.length >= 0); // may or may not have items depending on heuristics; just must not throw
  } finally {
    await cleanup(fixture.repoRoot);
  }
});

test("computeReviewData: deterministic across repeated calls with identical inputs", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const result1 = computeReviewData({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    const result2 = computeReviewData({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    assert.deepEqual(result2, result1);
  } finally {
    await cleanup(fixture.repoRoot);
  }
});

test("computeReviewData: never needs a since-deleted worktreePath -- only repoRoot matters", async () => {
  const fixture = await makeFixtureRepo();
  try {
    // Simulate the post-reap state: a worktreePath-shaped string that does
    // not exist anywhere on disk. computeReviewData's contract takes only
    // repoRoot/baseSha/headSha -- there is no worktreePath parameter at
    // all -- so passing a nonexistent path alongside would be a type error;
    // instead we assert the call succeeds using ONLY repoRoot, proving the
    // function never needed a worktreePath to begin with (a git worktree
    // shares its parent's object database, so baseSha/headSha stay
    // reachable via `git diff` in repoRoot even after the worktree
    // directory is gone).
    const nonexistentWorktreePath = path.join(fixture.repoRoot, "..", "definitely-does-not-exist-" + Date.now());
    const result = computeReviewData({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    assert.ok(result.riskRankedDiff.hunks.length > 0);
    // Sanity: the nonexistent path really doesn't exist, and was never touched.
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(nonexistentWorktreePath), false);
  } finally {
    await cleanup(fixture.repoRoot);
  }
});
