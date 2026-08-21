import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveBoardStage, unresolvedObjections, hasMajorUnresolved, type BoardStageInputs } from "../lib/board-data.js";
import { getRawLogMtimeMs } from "../lib/liveness-io.js";
import { deriveLiveness } from "../lib/run-status.js";
import type { RunState, CheckpointRecord } from "@pros/barrier";
import type { PlanRow, ObjectionRow } from "@pros/index";

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

function base(overrides: Partial<BoardStageInputs> = {}): BoardStageInputs {
  return {
    state: emptyState(),
    plans: [],
    hasVerifyVerdict: false,
    hasReviewCompleted: false,
    hasPrCreated: false,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 1,
    run_id: "r1",
    plan_id: "p1",
    version: 1,
    markdown: "",
    structured_json: "{}",
    state: "drafted",
    unresolved_objections_json: null,
    edited_at: null,
    edited_by: null,
    ...overrides,
  };
}

test("finding: no plan yet", () => {
  assert.equal(deriveBoardStage(base()), "finding");
});

test("planning: a plan exists but no plan_approval checkpoint at all", () => {
  assert.equal(deriveBoardStage(base({ plans: [plan()] })), "planning");
});

test("awaiting_gate1: plan_approval checkpoint is parked", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "parked" }));
  assert.equal(deriveBoardStage(base({ state, plans: [plan()] })), "awaiting_gate1");
});

test("implementing: plan_approval checkpoint answered, no verdict yet", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "answered", answer: "approve" }));
  assert.equal(deriveBoardStage(base({ state, plans: [plan()] })), "implementing");
});

test("verifying: has verify_verdict, no review_completed yet", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "answered" }));
  assert.equal(deriveBoardStage(base({ state, plans: [plan()], hasVerifyVerdict: true })), "verifying");
});

test("awaiting_gate2: verdict + review exist, no PR yet", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "answered" }));
  assert.equal(
    deriveBoardStage(base({ state, plans: [plan()], hasVerifyVerdict: true, hasReviewCompleted: true })),
    "awaiting_gate2",
  );
});

test("awaiting_gate2: pr_created but pr_review checkpoint still parked", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "answered" }));
  state.checkpoints.set("cp2", cp({ checkpointId: "cp2", gateType: "pr_review", phase: "parked" }));
  assert.equal(
    deriveBoardStage(
      base({ state, plans: [plan()], hasVerifyVerdict: true, hasReviewCompleted: true, hasPrCreated: true }),
    ),
    "awaiting_gate2",
  );
});

test("shipped: pr_created and pr_review checkpoint answered", () => {
  const state = emptyState();
  state.checkpoints.set("cp1", cp({ gateType: "plan_approval", phase: "answered" }));
  state.checkpoints.set(
    "cp2",
    cp({ checkpointId: "cp2", gateType: "pr_review", phase: "answered", answer: "reviewed", effect: "continue_within_approved_plan" }),
  );
  assert.equal(
    deriveBoardStage(
      base({ state, plans: [plan()], hasVerifyVerdict: true, hasReviewCompleted: true, hasPrCreated: true }),
    ),
    "shipped",
  );
});

test("awaiting_gate2: pr_created with no reviewed answer recorded", () => {
  assert.equal(deriveBoardStage(base({ hasPrCreated: true })), "awaiting_gate2");
});

test("awaiting_gate2: a non-reviewed Gate 2 answer is not shipped", () => {
  const state = emptyState();
  state.checkpoints.set("cp2", cp({ checkpointId: "cp2", gateType: "pr_review", phase: "answered", answer: "looks good", effect: "continue_within_approved_plan" }));
  assert.equal(deriveBoardStage(base({ state, hasPrCreated: true })), "awaiting_gate2");
});

test("unresolvedObjections / hasMajorUnresolved", () => {
  const objs: ObjectionRow[] = [
    { id: 1, plan_id: "p1", run_id: "r1", round: 1, author: "codex", severity: "major", claim: "x", suggested_change: null, resolution: "unresolved" },
    { id: 2, plan_id: "p1", run_id: "r1", round: 1, author: "codex", severity: "minor", claim: "y", suggested_change: null, resolution: "resolved" },
  ];
  const unresolved = unresolvedObjections(objs);
  assert.equal(unresolved.length, 1);
  assert.equal(hasMajorUnresolved(objs), true);
});

// B9 regression: proves the actual filesystem read (not just the pure
// deriveLiveness math already covered in run-status.test.ts) distinguishes
// a freshly-written raw.log ("active") from a stale one ("stale") from a
// run with no raw.log at all ("n/a", e.g. idle/finished/not-yet-spawned).
test("getRawLogMtimeMs + deriveLiveness: fresh raw.log -> active, stale raw.log -> stale, missing raw.log -> n/a", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-board-data-liveness-"));
  try {
    const runDir = path.join(runsRoot, "run-1");
    const attemptDir = path.join(runDir, "attempts", "run-1-implement");
    await mkdir(attemptDir, { recursive: true });
    const rawLogPath = path.join(attemptDir, "raw.log");
    await writeFile(rawLogPath, '{"type":"system"}\n');

    const freshMtime = await getRawLogMtimeMs(runDir, "run-1-implement");
    assert.ok(freshMtime !== undefined);
    assert.equal(deriveLiveness(freshMtime, Date.now()), "active");

    // Simulate a wedged session: the log stopped moving well past the
    // staleness threshold, but the "now" clock kept advancing.
    const farFuture = Date.now() + 10 * 60 * 1000;
    assert.equal(deriveLiveness(freshMtime, farFuture), "stale");

    const missing = await getRawLogMtimeMs(runDir, "run-1-does-not-exist");
    assert.equal(missing, undefined);
    assert.equal(deriveLiveness(missing, Date.now()), "n/a");
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
