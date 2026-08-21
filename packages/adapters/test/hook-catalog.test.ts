import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_EVENT_CATALOG,
  buildHookSettingsJson,
  buildHookSpawnExtraArgs,
  applyHookEvent,
  extractHookEvent,
  foldHookEvents,
  type HookLifecycleEvent,
} from "../src/hook-catalog.js";

test("buildHookSettingsJson: registers a hook for every catalog event, nothing else", () => {
  const parsed = JSON.parse(buildHookSettingsJson()) as { hooks: Record<string, unknown> };
  const registeredEvents = Object.keys(parsed.hooks).sort();
  assert.deepEqual(registeredEvents, [...HOOK_EVENT_CATALOG].sort());
});

test("buildHookSpawnExtraArgs: includes --include-hook-events and a --settings JSON payload", () => {
  const args = buildHookSpawnExtraArgs();
  assert.ok(args.includes("--include-hook-events"));
  const settingsIdx = args.indexOf("--settings");
  assert.ok(settingsIdx >= 0 && settingsIdx < args.length - 1, "expected --settings followed by a JSON payload");
  assert.doesNotThrow(() => JSON.parse(args[settingsIdx + 1]!));
});

test("extractHookEvent: recognizes a hook_started/hook_response 'system' line, ignores everything else", () => {
  const hookLine = { type: "system", data: { subtype: "hook_started", hook_event: "PreToolUse" }, seq: 5 };
  assert.deepEqual(extractHookEvent(hookLine), { seq: 5, hookEvent: "PreToolUse", subtype: "hook_started" });

  // The overwhelming majority of real lines: assistant/user/result/tool events, not hook lifecycle at all.
  assert.equal(extractHookEvent({ type: "assistant", data: {}, seq: 1 }), undefined);
  assert.equal(extractHookEvent({ type: "system", data: { subtype: "init" }, seq: 2 }), undefined);
  assert.equal(extractHookEvent({ type: "system", data: undefined, seq: 3 }), undefined);
});

test("applyHookEvent: PermissionRequest hook_started sets 'blocked' -- the exact wedged-but-alive case B9 targets", () => {
  const state = applyHookEvent(undefined, { seq: 1, hookEvent: "PermissionRequest", subtype: "hook_started" });
  assert.equal(state.label, "blocked");
});

test("applyHookEvent: the next hook event after a PermissionRequest clears 'blocked'", () => {
  let state = applyHookEvent(undefined, { seq: 1, hookEvent: "PermissionRequest", subtype: "hook_started" });
  state = applyHookEvent(state, { seq: 2, hookEvent: "PreToolUse", subtype: "hook_started" });
  assert.equal(state.label, "working");
});

// B9's hard requirement: "write a test that feeds events out of order" and
// prove the derived state is still correct -- the exact race the upstream
// prior art's PR #5 reverted a naive mapping over.
test("applyHookEvent: order-tolerant -- an out-of-order (lower-seq) event never regresses the state", () => {
  const events: HookLifecycleEvent[] = [
    { seq: 1, hookEvent: "SessionStart", subtype: "hook_started" },
    { seq: 2, hookEvent: "UserPromptSubmit", subtype: "hook_started" },
    { seq: 3, hookEvent: "PreToolUse", subtype: "hook_started" },
    { seq: 4, hookEvent: "PostToolUse", subtype: "hook_started" },
  ];

  // In-order application -- the reference result.
  let inOrder: ReturnType<typeof applyHookEvent> | undefined;
  for (const e of events) inOrder = applyHookEvent(inOrder, e);

  // Scrambled application, including a duplicate/stale re-delivery of an
  // already-superseded event arriving LAST (the realistic race: a slow
  // hook callback's line lands in raw.log after a faster, later one).
  const scrambled: HookLifecycleEvent[] = [events[2]!, events[0]!, events[3]!, events[1]!, events[0]!];
  let scrambledResult: ReturnType<typeof applyHookEvent> | undefined;
  for (const e of scrambled) scrambledResult = applyHookEvent(scrambledResult, e);

  assert.deepEqual(scrambledResult, inOrder, "final state must be identical regardless of arrival order");
  assert.equal(scrambledResult!.label, "working"); // PostToolUse (seq 4) is genuinely the latest
  assert.equal(scrambledResult!.seq, 4);
});

test("applyHookEvent: a stale hook_response arriving after a newer hook_started does not move seq or label backwards", () => {
  const started = applyHookEvent(undefined, { seq: 5, hookEvent: "PreToolUse", subtype: "hook_started" });
  const staleResponse = applyHookEvent(started, { seq: 2, hookEvent: "PreToolUse", subtype: "hook_response" });
  assert.deepEqual(staleResponse, started);
});

test("foldHookEvents: same order-tolerance guarantee via the list-folding convenience wrapper", () => {
  const events: HookLifecycleEvent[] = [
    { seq: 3, hookEvent: "PostToolUseFailure", subtype: "hook_started" },
    { seq: 1, hookEvent: "SessionStart", subtype: "hook_started" },
    { seq: 2, hookEvent: "UserPromptSubmit", subtype: "hook_started" },
  ];
  const state = foldHookEvents(events);
  assert.ok(state);
  assert.equal(state!.seq, 3);
  assert.equal(state!.label, "working");
});

test("foldHookEvents: empty input -> undefined (no hook activity observed yet)", () => {
  assert.equal(foldHookEvents([]), undefined);
});
