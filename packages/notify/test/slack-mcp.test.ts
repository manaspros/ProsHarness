import { test } from "node:test";
import assert from "node:assert/strict";
import { sendSlackMcp, type SlackMcpSession } from "../src/slack-mcp.js";

/**
 * Never hit a real Slack/claude call from tests -- every test here injects a
 * fake `SlackMcpSession`, mirroring how ntfy.test.ts exercises sendNtfy
 * against a real (but local, throwaway) http server rather than the real
 * ntfy.sh, and how wire-barrier.test.ts's timeout test uses a short
 * `timeoutMs` so the test itself stays fast.
 */

test("sendSlackMcp: session resolves cleanly -> ok:true", async () => {
  const session: SlackMcpSession = {
    run: async () => ({ text: "sent" }),
  };
  const result = await sendSlackMcp({ message: "hello", session });
  assert.deepEqual(result, { ok: true });
});

test("sendSlackMcp: session throws -> ok:false, error, never rejects", async () => {
  const session: SlackMcpSession = {
    run: async () => {
      throw new Error("MCP server disconnected");
    },
  };
  const result = await sendSlackMcp({ message: "hello", session });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /disconnected/);
});

test("sendSlackMcp: session that never resolves -> bounded timeout fires, ok:false, within the timeout window", async () => {
  const session: SlackMcpSession = {
    run: () => new Promise(() => undefined), // never resolves
  };
  const start = Date.now();
  const result = await sendSlackMcp({ message: "hello", session, timeoutMs: 50 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/i);
  assert.ok(elapsed < 1000, `expected timeout near 50ms, took ${elapsed}ms`);
});

test("sendSlackMcp: session that resolves after a long delay -> timeout still fires first", async () => {
  const session: SlackMcpSession = {
    run: () => new Promise((resolve) => setTimeout(() => resolve({ text: "too late" }), 2000)),
  };
  const start = Date.now();
  const result = await sendSlackMcp({ message: "hello", session, timeoutMs: 50 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/i);
  assert.ok(elapsed < 1000, `expected timeout near 50ms, took ${elapsed}ms`);
});

test("sendSlackMcp: no target given -> prompt tells the model to DM the user themselves, not a channel", async () => {
  let seenPrompt = "";
  const session: SlackMcpSession = {
    run: async (opts) => {
      seenPrompt = opts.prompt;
      return { text: "sent" };
    },
  };
  const result = await sendSlackMcp({ message: "hello", session });
  assert.equal(result.ok, true);
  assert.match(seenPrompt, /direct message to yourself/i);
  assert.doesNotMatch(seenPrompt, /channel "/i);
});

test("sendSlackMcp: target given -> prompt names that target, not the DM-yourself default", async () => {
  let seenPrompt = "";
  const session: SlackMcpSession = {
    run: async (opts) => {
      seenPrompt = opts.prompt;
      return { text: "sent" };
    },
  };
  const result = await sendSlackMcp({ message: "hello", target: "#eng-alerts", session });
  assert.equal(result.ok, true);
  assert.match(seenPrompt, /#eng-alerts/);
});

test("sendSlackMcp: message text is passed through to the prompt verbatim", async () => {
  let seenPrompt = "";
  const session: SlackMcpSession = {
    run: async (opts) => {
      seenPrompt = opts.prompt;
      return { text: "sent" };
    },
  };
  await sendSlackMcp({ message: "Run abc123: plan awaiting Gate 1 approval.", title: "ProsHarness", session });
  assert.match(seenPrompt, /Run abc123: plan awaiting Gate 1 approval\./);
  assert.match(seenPrompt, /ProsHarness/);
});
