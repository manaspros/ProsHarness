import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkGitCommitPreflight, runGit } from "../src/git.js";
import { makeTempRepo, cleanupDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

// This machine's own ~/.gitconfig legitimately sets a global user.signingkey
// (that's the whole reason this feature exists) -- isolate reads from it so
// these tests are deterministic regardless of the operator's real global
// config or whatever happens to be loaded in their real ssh-agent.
const HERMETIC_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

// --- checkGitCommitPreflight -------------------------------------------
//
// Regression class this closes: a global `commit.gpgsign = true` (real
// incident, 2026-08-21) makes `git commit` block forever on an interactive
// signing prompt inside a non-interactive harness subprocess. These tests
// exercise the read-only detection logic against a REAL local repo config
// and a REAL (but throwaway, never-loaded) ssh key -- no live signing
// prompt is ever triggered, since preflight only inspects config/agent
// state, it never runs `git commit` itself.

test("checkGitCommitPreflight: commit.gpgsign unset or false is never blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const result = await checkGitCommitPreflight(repo);
    assert.equal(result.blocked, false, "gpgsign is unset by default -- must not be blocked");

    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
    const result2 = await checkGitCommitPreflight(repo);
    assert.equal(result2.blocked, false);
  } finally {
    await cleanupDir(repo);
  }
});

test("checkGitCommitPreflight: gpgsign=true with no user.signingkey is blocked with an actionable remedy", async () => {
  const repo = await makeTempRepo();
  try {
    await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: repo });
    const result = await checkGitCommitPreflight(repo, HERMETIC_GIT_ENV);
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /user\.signingkey/);
    assert.match(result.remedy ?? "", /commit\.gpgsign false|user\.signingkey/);
  } finally {
    await cleanupDir(repo);
  }
});

test("checkGitCommitPreflight: gpg.format=ssh with a signing key NOT loaded in ssh-agent is blocked, naming ssh-add as the remedy", async () => {
  const repo = await makeTempRepo();
  const keyDir = await mkdtemp(path.join(tmpdir(), "pros-git-preflight-key-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  try {
    // A freshly generated key, never ssh-add'ed anywhere -- deterministic
    // stand-in for "the operator's real key isn't loaded in this session".
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "pros-test"]);

    await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: repo });
    await execFileAsync("git", ["config", "gpg.format", "ssh"], { cwd: repo });
    await execFileAsync("git", ["config", "user.signingkey", `${keyPath}.pub`], { cwd: repo });

    const result = await checkGitCommitPreflight(repo, HERMETIC_GIT_ENV);
    assert.equal(result.blocked, true, "an unloaded ssh signing key must block");
    assert.match(result.reason ?? "", /ssh-agent/);
    assert.match(result.remedy ?? "", /ssh-add/);
  } finally {
    await cleanupDir(repo);
    await rm(keyDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("checkGitCommitPreflight: gpg.format=ssh with the signing key loaded in ssh-agent is NOT blocked", async () => {
  const repo = await makeTempRepo();
  const keyDir = await mkdtemp(path.join(tmpdir(), "pros-git-preflight-key-"));
  const keyPath = path.join(keyDir, "id_ed25519");
  try {
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "pros-test"]);
    await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: repo });
    await execFileAsync("git", ["config", "gpg.format", "ssh"], { cwd: repo });
    await execFileAsync("git", ["config", "user.signingkey", `${keyPath}.pub`], { cwd: repo });

    await execFileAsync("ssh-add", [keyPath]);
    try {
      const result = await checkGitCommitPreflight(repo, HERMETIC_GIT_ENV);
      assert.equal(result.blocked, false, "a loaded ssh signing key must not block");
    } finally {
      // Never leave a throwaway test key sitting in the operator's real agent.
      await execFileAsync("ssh-add", ["-d", keyPath]).catch(() => undefined);
    }
  } finally {
    await cleanupDir(repo);
    await rm(keyDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// --- runGit timeout -------------------------------------------------------
//
// Regression class this closes: a hung git child (or a real `git commit`
// stuck on a signing prompt) must become a recorded failure, never silence.
// Uses a fake `git` shell script prepended to PATH -- a deterministic
// stand-in for a hanging real git, not a live CLI -- so the test is fast
// and never depends on this machine's actual signing/agent state.

async function makeFakeGitOnPath(script: string): Promise<{ binDir: string; restorePath: string }> {
  const binDir = await mkdtemp(path.join(tmpdir(), "pros-fake-git-"));
  const gitPath = path.join(binDir, "git");
  await writeFile(gitPath, script);
  await chmod(gitPath, 0o755);
  const restorePath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${restorePath}`;
  return { binDir, restorePath };
}

test("runGit: a hung child is killed and rejects with a GitTimeoutError naming the command and elapsed time", async () => {
  const marker = `pros-runGit-test-${process.pid}-${Date.now()}`;
  // Sleeps well past the test's timeout and forks a grandchild (also
  // tagged with `marker`) to prove the WHOLE process group dies, not just
  // the immediate child -- exactly the pinentry/ssh-keygen-under-git-commit
  // shape this guards against in production.
  const { binDir, restorePath } = await makeFakeGitOnPath(
    `#!/bin/sh\nperl -e 'sleep 999999' '${marker}-bg' &\nexec perl -e 'sleep 999999' '${marker}-fg'\n`,
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "pros-runGit-cwd-"));
  try {
    const start = Date.now();
    await assert.rejects(
      runGit(["commit", "-m", "x"], { cwd, timeoutMs: 300 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const e = err as Error & { command?: string; args?: string[]; timeoutMs?: number; elapsedMs?: number };
        assert.equal(e.command, "git");
        assert.deepEqual(e.args, ["commit", "-m", "x"]);
        assert.equal(e.timeoutMs, 300);
        assert.ok(typeof e.elapsedMs === "number" && e.elapsedMs >= 300);
        return true;
      },
    );
    const elapsedWall = Date.now() - start;
    assert.ok(elapsedWall < 5000, `runGit must reject promptly after the timeout, took ${elapsedWall}ms`);

    // Give the OS a moment to finish reaping the killed group, then confirm
    // no process tagged with `marker` survived -- proves group-kill, not
    // just killing the immediate `git` process.
    await new Promise((r) => setTimeout(r, 500));
    const { stdout } = await execFileAsync("pgrep", ["-f", marker]).catch(() => ({ stdout: "" }));
    assert.equal(stdout.trim(), "", "no descendant of the timed-out git child should still be running");
  } finally {
    process.env.PATH = restorePath;
    await rm(binDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("runGit: a fast, well-behaved git call still resolves normally under the same timeout machinery", async () => {
  const repo = await makeTempRepo();
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: repo, timeoutMs: 5000 });
    assert.match(stdout.trim(), /^[0-9a-f]{40}$/);
  } finally {
    await cleanupDir(repo);
  }
});
