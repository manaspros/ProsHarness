import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { TokenCeiling, TokenCeilingExceededError } from "@pros/lease";
import { runImplementation, AllowlistViolationError } from "../src/implement.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-implement-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * A fake session that "edits" a file and commits by actually performing the
 * write + `git commit` inside the test (simulating what the real CLI would
 * have done), then returns canned text/usage -- no live subprocess/model.
 */
class CommittingFakeSession {
  readonly provider = "claude" as const;
  constructor(
    private readonly cwd: string,
    private readonly filename: string,
    private readonly usage = { inputTokens: 100, outputTokens: 50 },
  ) {}

  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    await writeFile(path.join(this.cwd, this.filename), "fix\n");
    await execFileAsync("git", ["add", "."], { cwd: this.cwd });
    await execFileAsync("git", ["commit", "-q", "-m", "apply fix"], { cwd: this.cwd });
    return { text: "Applied the fix.", usage: this.usage };
  }
}

class NoopFakeSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: "Nothing needed to change.", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

test("session that commits a file within the allowlist -> committed true, correct headSha/filesChanged", async () => {
  const repo = await makeRepo();
  try {
    const session = new CommittingFakeSession(repo, "fix.txt");
    const result = await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan\nFix the thing.",
      fileAllowlist: ["fix.txt"],
      runId: "run-1",
      attemptId: "run-1-implement",
      repoRoot: REPO_ROOT,
    });

    assert.equal(result.committed, true);
    assert.deepEqual(result.filesChanged, ["fix.txt"]);
    const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    assert.equal(result.headSha, headSha);
    assert.notEqual(result.headSha, result.baseSha);
    assert.equal(result.summary, "Applied the fix.");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("session that makes no commit -> committed false", async () => {
  const repo = await makeRepo();
  try {
    const session = new NoopFakeSession();
    const result = await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan",
      fileAllowlist: [],
      runId: "run-2",
      attemptId: "run-2-implement",
      repoRoot: REPO_ROOT,
    });

    assert.equal(result.committed, false);
    assert.equal(result.headSha, result.baseSha);
    assert.deepEqual(result.filesChanged, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("commit touching a file outside the allowlist throws AllowlistViolationError naming it", async () => {
  const repo = await makeRepo();
  try {
    const session = new CommittingFakeSession(repo, "outside.txt");
    await assert.rejects(
      () =>
        runImplementation({
          claudeSession: session,
          worktreePath: repo,
          branch: "main",
          planMarkdown: "# Plan",
          fileAllowlist: ["only-this.txt"],
          runId: "run-3",
          attemptId: "run-3-implement",
          repoRoot: REPO_ROOT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AllowlistViolationError);
        assert.match((err as Error).message, /outside\.txt/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("tokenCeiling exceeded propagates TokenCeilingExceededError", async () => {
  const repo = await makeRepo();
  try {
    const session = new CommittingFakeSession(repo, "fix.txt", { inputTokens: 10_000, outputTokens: 10_000 });
    const ceiling = new TokenCeiling({ maxTotalTokens: 100 });
    await assert.rejects(
      () =>
        runImplementation({
          claudeSession: session,
          worktreePath: repo,
          branch: "main",
          planMarkdown: "# Plan",
          fileAllowlist: [],
          runId: "run-4",
          attemptId: "run-4-implement",
          repoRoot: REPO_ROOT,
          tokenCeiling: ceiling,
        }),
      TokenCeilingExceededError,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
