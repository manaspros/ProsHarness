import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { runAdversarialReview } from "../src/review.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function makeRepoWithDiff(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-review-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const baseSha = (await git(dir, ["rev-parse", "HEAD"])).trim();

  await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "add a line"], { cwd: dir });
  const headSha = (await git(dir, ["rev-parse", "HEAD"])).trim();

  return { dir, baseSha, headSha };
}

class JsonObjectionsSession {
  readonly provider: "claude" | "codex";
  constructor(
    provider: "claude" | "codex",
    private readonly objections: unknown[],
  ) {
    this.provider = provider;
  }

  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ objections: this.objections }), usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

test("both passes return zero objections -> approve, empty unresolvedBlockers", async () => {
  const { dir, baseSha, headSha } = await makeRepoWithDiff();
  try {
    const result = await runAdversarialReview({
      claudeSession: new JsonObjectionsSession("claude", []),
      codexSession: new JsonObjectionsSession("codex", []),
      worktreePath: dir,
      repoRoot: REPO_ROOT,
      baseSha,
      headSha,
      planMarkdown: "# Plan",
      runId: "run-1",
      attemptIdPrefix: "run-1",
    });
    assert.equal(result.verdict, "approve");
    assert.deepEqual(result.objections, []);
    assert.deepEqual(result.unresolvedBlockers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex returns one blocker -> blockers-present, blocker is in unresolvedBlockers", async () => {
  const { dir, baseSha, headSha } = await makeRepoWithDiff();
  try {
    const blocker = { severity: "blocker", claim: "off-by-one bug introduced", suggested_change: "fix the bound" };
    const result = await runAdversarialReview({
      claudeSession: new JsonObjectionsSession("claude", []),
      codexSession: new JsonObjectionsSession("codex", [blocker]),
      worktreePath: dir,
      repoRoot: REPO_ROOT,
      baseSha,
      headSha,
      planMarkdown: "# Plan",
      runId: "run-2",
      attemptIdPrefix: "run-2",
    });
    assert.equal(result.verdict, "blockers-present");
    assert.equal(result.unresolvedBlockers.length, 1);
    assert.equal(result.unresolvedBlockers[0]!.claim, "off-by-one bug introduced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only minor/major objections from either pass -> still approve", async () => {
  const { dir, baseSha, headSha } = await makeRepoWithDiff();
  try {
    const result = await runAdversarialReview({
      claudeSession: new JsonObjectionsSession("claude", [
        { severity: "minor", claim: "nit: naming", suggested_change: "rename" },
      ]),
      codexSession: new JsonObjectionsSession("codex", [
        { severity: "major", claim: "missing test", suggested_change: "add a test" },
      ]),
      worktreePath: dir,
      repoRoot: REPO_ROOT,
      baseSha,
      headSha,
      planMarkdown: "# Plan",
      runId: "run-3",
      attemptIdPrefix: "run-3",
    });
    assert.equal(result.verdict, "approve");
    assert.equal(result.objections.length, 2);
    assert.deepEqual(result.unresolvedBlockers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
