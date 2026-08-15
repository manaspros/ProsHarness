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
