import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RealClaudeSession } from "../src/real-sessions.js";

async function withFakeClaude<T>(scriptBody: string, run: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(path.join(tmpdir(), "pros-plan-fake-claude-"));
  const executable = path.join(binDir, "claude");
  await writeFile(executable, `#!/bin/sh\n${scriptBody}\n`, "utf8");
  await chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;
  try {
    return await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(binDir, { recursive: true, force: true });
  }
}

test("RealClaudeSession bounds a real CLI timeout and cleans up a CLI that ignores SIGTERM", async () => {
  const started = Date.now();
  await withFakeClaude(
    [
      `if [ "$1" = "--version" ]; then printf 'fake claude 2.1.232\\n'; exit 0; fi`,
      `trap '' TERM`,
      `while :; do sleep 1; done`,
    ].join("\n"),
    async () => {
      await assert.rejects(
        () =>
          new RealClaudeSession().run({
            cwd: process.cwd(),
            prompt: "timeout test",
            attemptId: "real-session-timeout",
            timeoutMs: 25,
          }),
        /timed out after 25ms/,
      );
    },
  );
  assert.ok(Date.now() - started < 2_500, "a timed-out real session must not leave its CLI running");
});

test("RealClaudeSession reports a nonzero CLI exit with stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pros-plan-real-session-exit-"));
  const rawLogPath = path.join(root, "attempt", "raw.log");
  try {
    await withFakeClaude(
      [
        `if [ "$1" = "--version" ]; then printf 'fake claude 2.1.232\\n'; exit 0; fi`,
        `printf 'provider failed\\n' >&2`,
        `exit 7`,
      ].join("\n"),
      async () => {
        await assert.rejects(
          () =>
            new RealClaudeSession().run({
              cwd: process.cwd(),
              prompt: "exit test",
              attemptId: "real-session-nonzero",
              rawLogPath,
            }),
          /exited unsuccessfully.*exitCode=7.*provider failed/s,
        );
        assert.equal(await readFile(path.join(root, "attempt", "cli_version.txt"), "utf8"), "fake claude 2.1.232\n");
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RealClaudeSession fails and cleans up when its raw log cannot be written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pros-plan-real-session-raw-log-"));
  const rawLogPath = path.join(root, "attempt", "raw.log");
  await mkdir(rawLogPath, { recursive: true });
  const started = Date.now();
  try {
    await withFakeClaude(
      [
        `if [ "$1" = "--version" ]; then printf 'fake claude 2.1.232\\n'; exit 0; fi`,
        `trap '' TERM`,
        `printf '%s\\n' '{"type":"result","result":"ok","session_id":"raw-log-test"}'`,
        `while :; do sleep 1; done`,
      ].join("\n"),
      async () => {
        await assert.rejects(
          () =>
            new RealClaudeSession().run({
              cwd: process.cwd(),
              prompt: "raw log test",
              attemptId: "real-session-raw-log",
              rawLogPath,
            }),
          /failed to write raw log/,
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(Date.now() - started < 2_500, "a raw-log failure must not leave its CLI running");
});

test("RealClaudeSession persists the observed CLI version beside the raw log", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pros-plan-real-session-version-"));
  const rawLogPath = path.join(root, "attempt", "raw.log");
  try {
    await withFakeClaude(
      [
        `if [ "$1" = "--version" ]; then printf 'fake claude 2.1.232\\n'; exit 0; fi`,
        `printf '%s\\n' '{"type":"result","result":"ok","session_id":"version-test","usage":{"input_tokens":2,"output_tokens":3}}'`,
      ].join("\n"),
      async () => {
        const result = await new RealClaudeSession().run({
          cwd: process.cwd(),
          prompt: "version test",
          attemptId: "real-session-version",
          rawLogPath,
        });

        assert.equal(result.text, "ok");
        assert.equal(result.sessionId, "version-test");
        assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
        assert.equal(await readFile(path.join(root, "attempt", "cli_version.txt"), "utf8"), "fake claude 2.1.232\n");
        assert.match(await readFile(rawLogPath, "utf8"), /"type":"result"/);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
