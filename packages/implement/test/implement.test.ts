import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { TokenCeiling, TokenCeilingExceededError } from "@pros/lease";
import { InvalidFileAllowlistError, runImplementation, AllowlistViolationError } from "../src/implement.js";
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
      fileAllowlist: ["fix.txt"],
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

/** Captures the prompt it was invoked with, then behaves like CommittingFakeSession. */
class CapturingFakeSession {
  readonly provider = "claude" as const;
  public lastPrompt = "";
  constructor(
    private readonly cwd: string,
    private readonly filename: string,
  ) {}
  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    this.lastPrompt = opts.prompt;
    await writeFile(path.join(this.cwd, this.filename), "fix\n");
    await execFileAsync("git", ["add", "."], { cwd: this.cwd });
    await execFileAsync("git", ["commit", "-q", "-m", "apply fix"], { cwd: this.cwd });
    return { text: "Applied the fix.", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

test("agentBriefPath override: a project-declared brief path is loaded instead of the .claude/agents/scoped-fixer.md default", async () => {
  const repo = await makeRepo();
  try {
    // Committed up front (not left untracked) -- CapturingFakeSession commits
    // via `git add .`, and an untracked custom-brief.md would otherwise show
    // up in the diff and trip the fileAllowlist check this test isn't about.
    await writeFile(
      path.join(repo, "custom-brief.md"),
      ["---", "name: custom-brief", "model: sonnet", "tools: Edit", "---", "", "MARKER: this is the project's own brief."].join(
        "\n",
      ),
    );
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "add custom brief"], { cwd: repo });

    const session = new CapturingFakeSession(repo, "fix.txt");
    await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan",
      fileAllowlist: ["fix.txt"],
      runId: "run-brief-override",
      attemptId: "run-brief-override-implement",
      repoRoot: repo,
      agentBriefPath: "custom-brief.md",
    });
    assert.match(session.lastPrompt, /MARKER: this is the project's own brief\./);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("agentBriefPath omitted: falls back to today's default .claude/agents/scoped-fixer.md convention (loads ProsHarness's own brief)", async () => {
  const repo = await makeRepo();
  try {
    const session = new CapturingFakeSession(repo, "fix.txt");
    await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan",
      fileAllowlist: ["fix.txt"],
      runId: "run-brief-default",
      attemptId: "run-brief-default-implement",
      repoRoot: REPO_ROOT,
    });
    assert.match(session.lastPrompt.toLowerCase(), /allowlist/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/** Captures the full ModelRunOptions it was invoked with, then behaves like CommittingFakeSession. */
class OptsCapturingFakeSession {
  readonly provider = "claude" as const;
  public lastOpts: ModelRunOptions | undefined;
  constructor(
    private readonly cwd: string,
    private readonly filename: string,
  ) {}
  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    this.lastOpts = opts;
    await writeFile(path.join(this.cwd, this.filename), "fix\n");
    await execFileAsync("git", ["add", "."], { cwd: this.cwd });
    await execFileAsync("git", ["commit", "-q", "-m", "apply fix"], { cwd: this.cwd });
    return { text: "Applied the fix.", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

/**
 * Phase 2 (headless implement permission grant): proves `runImplementation`
 * requests the scoped `acceptEdits`/`allowedTools` grant on the
 * `ModelSession` it drives -- NEVER `dangerouslySkipPermissions` -- and that
 * an unregistered project repo root falls back to (rather than silently
 * omitting) ProsHarness's own validation commands.
 */
test("runImplementation requests acceptEdits + allowedTools on the session, never dangerouslySkipPermissions, and falls back to ProsHarness's own validation commands for an unregistered project", async () => {
  const repo = await makeRepo();
  try {
    const session = new OptsCapturingFakeSession(repo, "fix.txt");
    await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan",
      fileAllowlist: ["fix.txt"],
      runId: "run-perm-1",
      attemptId: "run-perm-1-implement",
      repoRoot: REPO_ROOT,
      projectRepoRoot: repo, // a throwaway temp-dir repo is never in PROJECT_REGISTRY -> fallback path
    });

    assert.equal(session.lastOpts?.permissionMode, "acceptEdits");
    assert.equal(session.lastOpts?.dangerouslySkipPermissions, undefined);
    const tools = session.lastOpts?.allowedTools ?? [];
    for (const gitTool of ["Bash(git add *)", "Bash(git commit *)", "Bash(git diff *)", "Bash(git status *)"]) {
      assert.ok(tools.includes(gitTool), `expected ${gitTool} in allowedTools, got: ${JSON.stringify(tools)}`);
    }
    assert.ok(!tools.some((t) => t.includes("git push")), "must never grant git push to the model session");
    // Fallback validation commands (ProsHarness's own), since `repo` (a
    // throwaway temp dir) resolves to no PROJECT_REGISTRY entry.
    assert.ok(tools.includes("Bash(pnpm run typecheck *)"), `expected fallback typecheck command in: ${JSON.stringify(tools)}`);
    assert.ok(tools.includes("Bash(pnpm run test *)"), `expected fallback test command in: ${JSON.stringify(tools)}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/** A registered PROJECT_REGISTRY project's own validationCommands reach --allowedTools instead of the fallback. */
test("runImplementation: a resolved project's validationCommands reach allowedTools instead of the fallback", async () => {
  const repo = await makeRepo();
  try {
    const session = new OptsCapturingFakeSession(repo, "fix.txt");
    // "agent-gateway"'s registered repoRoot won't match `repo`, so instead
    // resolve via a real registered repoRoot to prove the non-fallback path
    // reads PROJECT_REGISTRY's actual commands, not the hardcoded fallback.
    const { PROJECT_REGISTRY } = await import("../src/project-config.js");
    const agentGateway = PROJECT_REGISTRY.find((p) => p.name === "agent-gateway")!;
    await runImplementation({
      claudeSession: session,
      worktreePath: repo,
      branch: "main",
      planMarkdown: "# Plan",
      fileAllowlist: ["fix.txt"],
      runId: "run-perm-2",
      attemptId: "run-perm-2-implement",
      repoRoot: REPO_ROOT,
      projectRepoRoot: agentGateway.repoRoot,
    });

    const tools = session.lastOpts?.allowedTools ?? [];
    assert.ok(tools.includes("Bash(just verify *)"), `expected agent-gateway's own command in: ${JSON.stringify(tools)}`);
    assert.ok(tools.includes("Bash(cargo test --locked *)"), `expected agent-gateway's own command in: ${JSON.stringify(tools)}`);
    assert.ok(!tools.includes("Bash(pnpm run test *)"), "must not fall back once a real project resolves");
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
          fileAllowlist: ["fix.txt"],
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

test("empty or malformed allowlists refuse before the model can make arbitrary changes", async () => {
  for (const fileAllowlist of [
    [],
    undefined,
    [undefined],
    [""],
  ] as unknown[]) {
    const repo = await makeRepo();
    let sessionCalled = false;
    try {
      const session = {
        provider: "claude" as const,
        async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
          sessionCalled = true;
          throw new Error("the model must not run with an invalid allowlist");
        },
      };

      await assert.rejects(
        () =>
          runImplementation({
            claudeSession: session,
            worktreePath: repo,
            branch: "main",
            planMarkdown: "# Plan",
            fileAllowlist: fileAllowlist as string[],
            runId: "invalid-scope",
            attemptId: "invalid-scope-implement",
            repoRoot: REPO_ROOT,
          }),
        InvalidFileAllowlistError,
      );
      assert.equal(sessionCalled, false);
      assert.equal((await git(repo, ["status", "--porcelain"])).trim(), "");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});
