import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnCli } from "../src/spawn-common.js";
import { buildClaudeArgs } from "../src/claude.js";
import type { ParsedEvent } from "../src/types.js";

test("buildClaudeArgs only enables permission bypass when explicitly requested", () => {
  assert.ok(!buildClaudeArgs({}).includes("--dangerously-skip-permissions"));
  assert.ok(buildClaudeArgs({ dangerouslySkipPermissions: true }).includes("--dangerously-skip-permissions"));
});

/**
 * Phase 2 (headless implement permission grant): proves the scoped
 * `acceptEdits` + `--allowedTools` grant the implement stage requests
 * produces the exact argv a real `claude -p` invocation needs -- confirmed
 * against `claude --help` on 2.1.232: `--permission-mode <mode>` (choices
 * include "acceptEdits") and `--allowedTools, --allowed-tools <tools...>`
 * ("Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
 * Edit")"). Each allowedTools pattern must survive as ONE argv element
 * (spawn() never re-splits array items on whitespace), so this also guards
 * against a future refactor that joins the list into a single string.
 */
test("buildClaudeArgs: acceptEdits + allowedTools produces the exact --permission-mode/--allowedTools argv", () => {
  const args = buildClaudeArgs({
    permissionMode: "acceptEdits",
    allowedTools: ["Bash(git add *)", "Bash(git commit *)", "Bash(pnpm run test *)"],
  });

  const modeIdx = args.indexOf("--permission-mode");
  assert.notEqual(modeIdx, -1, "expected --permission-mode to be present");
  assert.equal(args[modeIdx + 1], "acceptEdits");

  const toolsIdx = args.indexOf("--allowedTools");
  assert.notEqual(toolsIdx, -1, "expected --allowedTools to be present");
  assert.equal(args[toolsIdx + 1], "Bash(git add *)");
  assert.equal(args[toolsIdx + 2], "Bash(git commit *)");
  assert.equal(args[toolsIdx + 3], "Bash(pnpm run test *)");
});

test("buildClaudeArgs: omits --permission-mode/--allowedTools when neither is requested", () => {
  const args = buildClaudeArgs({});
  assert.ok(!args.includes("--permission-mode"));
  assert.ok(!args.includes("--allowedTools"));
});

/**
 * SECURITY REGRESSION TEST -- this is the hard constraint from the phase
 * brief: a scoped `acceptEdits`/`allowedTools` grant must NEVER also emit
 * `--dangerously-skip-permissions`. The official docs restrict full bypass
 * to disposable, no-internet sandboxes and state plainly it is no defense
 * against prompt injection; this repo's worktree-bounded `acceptEdits` grant
 * is the whole reason that constraint can be satisfied here. If this test
 * ever fails, something re-introduced the bypass flag alongside (or instead
 * of) the scoped grant -- treat that as a security regression, not a flaky
 * test.
 */
test("SECURITY: buildClaudeArgs never emits --dangerously-skip-permissions for a scoped acceptEdits/allowedTools grant", () => {
  const args = buildClaudeArgs({
    permissionMode: "acceptEdits",
    allowedTools: ["Bash(git add *)", "Bash(git commit *)", "Bash(git diff *)", "Bash(git status *)", "Bash(pnpm run test *)"],
  });
  assert.ok(
    !args.includes("--dangerously-skip-permissions"),
    `expected no --dangerously-skip-permissions in scoped-grant argv, got: ${JSON.stringify(args)}`,
  );
  // Also never let a push slip into the allowlist itself -- the deterministic
  // orchestrator opens the PR, never the model session (see pr.ts).
  assert.ok(!args.some((a) => a.includes("git push")), "the model session must never be granted git push");
});

test("buildClaudeArgs: dangerouslySkipPermissions, if ever set alongside permissionMode/allowedTools, wins (and the scoped flags are dropped) -- documents existing precedence, does not endorse combining them", () => {
  const args = buildClaudeArgs({
    dangerouslySkipPermissions: true,
    permissionMode: "acceptEdits",
    allowedTools: ["Bash(git add *)"],
  });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--permission-mode"));
  assert.ok(!args.includes("--allowedTools"));
});

/**
 * Proves the credential-stripping property described in spawn-common.ts's
 * `stripGhCredentials`: a model/agent subprocess spawned via `spawnCli` (and
 * therefore via `spawnClaude`/`spawnCodex`, which both route through it) must
 * never see `GH_TOKEN`/`GITHUB_TOKEN`, and must see a `GH_CONFIG_DIR` that
 * cannot contain a real ambient `gh auth login` session -- EVEN IF the
 * parent process (simulating an operator's ambient shell) has `GH_TOKEN`/
 * `GITHUB_TOKEN` set. Runs a cheap, fully offline `node -e` child that just
 * echoes back what it sees in its own env, so this needs no real `gh`
 * binary and no real GitHub credential.
 */
test("spawnCli strips GH_TOKEN/GITHUB_TOKEN and repoints GH_CONFIG_DIR, even with ambient credentials set", async () => {
  const prevGhToken = process.env.GH_TOKEN;
  const prevGithubToken = process.env.GITHUB_TOKEN;
  const prevGhConfigDir = process.env.GH_CONFIG_DIR;
  try {
    // Simulate an operator's ambient shell that happens to have real-looking
    // GitHub credentials exported.
    process.env.GH_TOKEN = "ambient-operator-gh-token";
    process.env.GITHUB_TOKEN = "ambient-operator-github-token";
    process.env.GH_CONFIG_DIR = "/some/real/looking/gh/config/dir";

    const script =
      "console.log(JSON.stringify({" +
      "GH_TOKEN: process.env.GH_TOKEN," +
      "GITHUB_TOKEN: process.env.GITHUB_TOKEN," +
      "GH_CONFIG_DIR: process.env.GH_CONFIG_DIR" +
      "}))";

    const events: ParsedEvent[] = [];
    const result = spawnCli({
      command: "node",
      args: ["-e", script],
      provider: "claude",
      opts: {
        cwd: process.cwd(),
        prompt: "",
        attemptId: "spawn-common-test-1",
      },
      parseLine: (raw, seq) => ({ provider: "claude", seq, raw, parseStatus: "ok" as const, data: raw }),
    });

    for await (const event of result.events) {
      events.push(event);
    }
    await result.exitCode;

    assert.equal(events.length, 1, "expected exactly one line of output from the child");
    const reported = JSON.parse(events[0]!.raw) as {
      GH_TOKEN?: string;
      GITHUB_TOKEN?: string;
      GH_CONFIG_DIR?: string;
    };

    assert.equal(reported.GH_TOKEN, undefined, "GH_TOKEN must never leak into a model subprocess's env");
    assert.equal(reported.GITHUB_TOKEN, undefined, "GITHUB_TOKEN must never leak into a model subprocess's env");
    assert.notEqual(
      reported.GH_CONFIG_DIR,
      "/some/real/looking/gh/config/dir",
      "GH_CONFIG_DIR must be repointed away from the operator's real ambient gh config dir",
    );
    assert.ok(reported.GH_CONFIG_DIR && reported.GH_CONFIG_DIR.length > 0, "GH_CONFIG_DIR must be set to some scratch path");
  } finally {
    if (prevGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGhToken;
    if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithubToken;
    if (prevGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = prevGhConfigDir;
  }
});

test("spawnCli also strips GH_TOKEN passed via opts.env (simulating a caller forwarding ambient state explicitly)", async () => {
  const script = "console.log(JSON.stringify({ GH_TOKEN: process.env.GH_TOKEN }))";

  const events: ParsedEvent[] = [];
  const result = spawnCli({
    command: "node",
    args: ["-e", script],
    provider: "codex",
    opts: {
      cwd: process.cwd(),
      prompt: "",
      attemptId: "spawn-common-test-2",
      env: { GH_TOKEN: "explicitly-passed-token" },
    },
    parseLine: (raw, seq) => ({ provider: "codex", seq, raw, parseStatus: "ok" as const, data: raw }),
  });

  for await (const event of result.events) {
    events.push(event);
  }
  await result.exitCode;

  const reported = JSON.parse(events[0]!.raw) as { GH_TOKEN?: string };
  assert.equal(reported.GH_TOKEN, undefined, "GH_TOKEN passed via opts.env must still be stripped before spawning");
});

/**
 * SECURITY: Phase 6 hard constraint -- a job-level `OPENAI_API_KEY`/
 * `CODEX_API_KEY` (this test's live pre-existing failure note calls out an
 * ambient `OPENAI_API_KEY` set in this very dev shell) must never reach a
 * `codex` subprocess; the installed CLI is expected to authenticate from its
 * own credential store. Scoped to provider "codex" only -- a claude spawn is
 * deliberately left untouched by the second assertion below.
 */
test("spawnCli strips OPENAI_API_KEY/CODEX_API_KEY for codex spawns only, even with ambient keys set", async () => {
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  const prevCodexKey = process.env.CODEX_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-ambient-operator-key";
    process.env.CODEX_API_KEY = "ambient-codex-key";

    const script = "console.log(JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY }))";

    const codexEvents: ParsedEvent[] = [];
    const codexResult = spawnCli({
      command: "node",
      args: ["-e", script],
      provider: "codex",
      opts: { cwd: process.cwd(), prompt: "", attemptId: "spawn-common-test-codex-key" },
      parseLine: (raw, seq) => ({ provider: "codex", seq, raw, parseStatus: "ok" as const, data: raw }),
    });
    for await (const event of codexResult.events) codexEvents.push(event);
    await codexResult.exitCode;

    const reportedForCodex = JSON.parse(codexEvents[0]!.raw) as { OPENAI_API_KEY?: string; CODEX_API_KEY?: string };
    assert.equal(reportedForCodex.OPENAI_API_KEY, undefined, "OPENAI_API_KEY must never leak into a codex subprocess");
    assert.equal(reportedForCodex.CODEX_API_KEY, undefined, "CODEX_API_KEY must never leak into a codex subprocess");

    // A claude spawn has no such concern -- confirm the strip is scoped to
    // provider "codex" and does not silently start deleting env everywhere.
    const claudeEvents: ParsedEvent[] = [];
    const claudeResult = spawnCli({
      command: "node",
      args: ["-e", script],
      provider: "claude",
      opts: { cwd: process.cwd(), prompt: "", attemptId: "spawn-common-test-claude-key" },
      parseLine: (raw, seq) => ({ provider: "claude", seq, raw, parseStatus: "ok" as const, data: raw }),
    });
    for await (const event of claudeResult.events) claudeEvents.push(event);
    await claudeResult.exitCode;

    const reportedForClaude = JSON.parse(claudeEvents[0]!.raw) as { OPENAI_API_KEY?: string };
    assert.equal(reportedForClaude.OPENAI_API_KEY, "sk-ambient-operator-key", "the strip must be scoped to provider codex, not applied globally");
  } finally {
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    if (prevCodexKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = prevCodexKey;
  }
});

test("spawnCli buffers stderr for failed-session diagnostics", async () => {
  const result = spawnCli({
    command: "node",
    args: ["-e", "process.stderr.write('codex approval failed'); console.log('{}')"],
    provider: "codex",
    opts: { cwd: process.cwd(), prompt: "", attemptId: "spawn-common-test-stderr" },
    parseLine: (raw, seq) => ({ provider: "codex", seq, raw, parseStatus: "ok" as const, data: raw }),
  });

  for await (const _event of result.events) {
    // Drain stdout so the child lifecycle is fully observed.
  }
  await result.exitCode;
  assert.match(await result.stderr, /codex approval failed/);
});
