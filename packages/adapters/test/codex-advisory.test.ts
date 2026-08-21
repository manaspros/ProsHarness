import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexAdvisoryExtraArgs, collectCodexAdvisoryOutcome, buildCodexArgs, parseCodexLine } from "../src/codex.js";
import type { ParsedEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildCodexAdvisoryExtraArgs -- the read-only, structured-verdict shape.
// ---------------------------------------------------------------------------

test("buildCodexAdvisoryExtraArgs: exact --sandbox read-only / --output-schema <path> argv", () => {
  const args = buildCodexAdvisoryExtraArgs("/tmp/some/schema.json");
  assert.deepEqual(args, ["--sandbox", "read-only", "--output-schema", "/tmp/some/schema.json"]);
});

test("SECURITY: buildCodexAdvisoryExtraArgs never requests workspace-write or a full sandbox bypass", () => {
  const args = buildCodexAdvisoryExtraArgs("/tmp/schema.json");
  assert.ok(!args.includes("workspace-write"));
  assert.ok(!args.includes("danger-full-access"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("buildCodexArgs: extraArgs (e.g. the advisory --sandbox/--output-schema pair) sit between --json and the final '-' positional", () => {
  const args = buildCodexArgs({ extraArgs: buildCodexAdvisoryExtraArgs("/tmp/schema.json") });
  assert.deepEqual(args, ["exec", "--json", "--sandbox", "read-only", "--output-schema", "/tmp/schema.json", "-"]);
});

// ---------------------------------------------------------------------------
// collectCodexAdvisoryOutcome -- graceful-degradation event interpretation.
// ---------------------------------------------------------------------------

async function* fromLines(lines: string[]): AsyncIterable<ParsedEvent> {
  let seq = 0;
  for (const line of lines) {
    yield parseCodexLine(line, seq);
    seq += 1;
  }
}

test("collectCodexAdvisoryOutcome: extracts the final agent_message text, skipping an earlier non-agent_message item.completed", async () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "deprecation notice" } }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: '{"raised_blocker":true,"findings":[]}' },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ];
  const outcome = await collectCodexAdvisoryOutcome(fromLines(lines));
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.text, '{"raised_blocker":true,"findings":[]}');
});

test("collectCodexAdvisoryOutcome: a turn.failed event degrades to status turn_failed with a diagnostic detail, never throws", async () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.failed", error: "sandbox denied a required write" }),
  ];
  const outcome = await collectCodexAdvisoryOutcome(fromLines(lines));
  assert.equal(outcome.status, "turn_failed");
  assert.ok(outcome.detail?.includes("sandbox denied"));
});

test("collectCodexAdvisoryOutcome: no agent_message at all degrades to status no_agent_message", async () => {
  const lines = [JSON.stringify({ type: "thread.started", thread_id: "t1" }), JSON.stringify({ type: "turn.completed", usage: {} })];
  const outcome = await collectCodexAdvisoryOutcome(fromLines(lines));
  assert.equal(outcome.status, "no_agent_message");
});

test("collectCodexAdvisoryOutcome: malformed JSON lines don't throw -- treated as absent agent_message", async () => {
  const outcome = await collectCodexAdvisoryOutcome(fromLines(["not json at all"]));
  assert.equal(outcome.status, "no_agent_message");
});
