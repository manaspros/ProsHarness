import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunStatus, findRunningAttemptId, deriveLiveness, STALE_RAW_LOG_THRESHOLD_MS } from "../lib/run-status.js";
import type { RunState, CheckpointRecord, AttemptRecord } from "@pros/barrier";

function emptyState(): RunState {
  return {
    fenceEpoch: 0,
    attempts: new Map(),
    checkpoints: new Map(),
    idempotencyIndex: new Map(),
    hookPayloads: [],
    lastSeq: -1,
    truncated: false,
  };
}

function cp(overrides: Partial<CheckpointRecord>): CheckpointRecord {
  return {
    checkpointId: "cp1",
    attemptId: "a1",
    questionId: "q1",
    idempotencyKey: "k1",
    prompt: "p",
    options: [],
    phase: "parked",
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    attemptId: "a1",
    cwd: "/tmp",
    launchConfigHash: "h",
    unitName: "u",
    phase: "running",
    fenceEpochAtStart: 0,
    ...overrides,
  };
}

test("idle: no attempts, no checkpoints", () => {
  assert.equal(deriveRunStatus(emptyState()), "idle");
});

test("running: an attempt with no endedReason", () => {
  const state = emptyState();
  state.attempts.set("a1", attempt({}));
  assert.equal(deriveRunStatus(state), "running");
});

test("done: attempt has endedReason and no checkpoints parked", () => {
  const state = emptyState();
  state.attempts.set("a1", attempt({ endedReason: "parked" }));
  assert.equal(deriveRunStatus(state), "done");
});

test("parked_awaiting_plan_approval: parked checkpoint with gateType plan_approval", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ phase: "parked", gateType: "plan_approval" }));
  assert.equal(deriveRunStatus(state), "parked_awaiting_plan_approval");
});

test("parked_awaiting_answer: parked checkpoint with gateType ask_human", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ phase: "parked", gateType: "ask_human" }));
  assert.equal(deriveRunStatus(state), "parked_awaiting_answer");
});

test("parked_awaiting_answer: parked checkpoint with no gateType (legacy default)", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ phase: "parked", gateType: undefined }));
  assert.equal(deriveRunStatus(state), "parked_awaiting_answer");
});

test("parked_awaiting_gate2: parked pr_review checkpoint", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ phase: "parked", gateType: "pr_review" }));
  assert.equal(deriveRunStatus(state), "parked_awaiting_gate2");
});

test("a non-parked checkpoint does not count as parked", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ phase: "answered", gateType: "ask_human" }));
  state.attempts.set("a2", attempt({ attemptId: "a2", endedReason: "resumed" }));
  assert.equal(deriveRunStatus(state), "done");
});

test("parked takes priority even if some attempt looks still-running", () => {
  const state = emptyState();
  state.attempts.set("a1", attempt({}));
  state.checkpoints.set("cp1", cp({ phase: "parked", gateType: "plan_approval" }));
  assert.equal(deriveRunStatus(state), "parked_awaiting_plan_approval");
});

// B9 regression: journal-only status ("running") cannot tell an actively
// producing session apart from one wedged on a hung tool call. These pin
// findRunningAttemptId/deriveLiveness -- the pure half of that fix (the I/O
// half, reading raw.log's real mtime, is board-data.test.ts's job).

test("findRunningAttemptId: returns the attempt with no endedReason", () => {
  const state = emptyState();
  state.attempts.set("a1", attempt({ attemptId: "a1", endedReason: "ended" }));
  state.attempts.set("a2", attempt({ attemptId: "a2" }));
  assert.equal(findRunningAttemptId(state), "a2");
});

test("findRunningAttemptId: undefined when no attempt is running", () => {
  const state = emptyState();
  state.attempts.set("a1", attempt({ attemptId: "a1", endedReason: "ended" }));
  assert.equal(findRunningAttemptId(state), undefined);
});

test("deriveLiveness: no raw.log mtime yet (attempt just spawned) -> n/a, not stale", () => {
  assert.equal(deriveLiveness(undefined, 1_000_000), "n/a");
});

test("deriveLiveness: mtime just under the threshold -> active", () => {
  const now = 1_000_000;
  const mtime = now - (STALE_RAW_LOG_THRESHOLD_MS - 1);
  assert.equal(deriveLiveness(mtime, now), "active");
});

test("deriveLiveness: mtime past the threshold -> stale (the wedged case)", () => {
  const now = 1_000_000;
  const mtime = now - (STALE_RAW_LOG_THRESHOLD_MS + 1);
  assert.equal(deriveLiveness(mtime, now), "stale");
});
