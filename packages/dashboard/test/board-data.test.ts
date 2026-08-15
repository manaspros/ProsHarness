import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoardStage, unresolvedObjections, hasMajorUnresolved, type BoardStageInputs } from "../lib/board-data.js";
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
  state.checkpoints.set("cp2", cp({ checkpointId: "cp2", gateType: "pr_review", phase: "answered", answer: "reviewed" }));
  assert.equal(
    deriveBoardStage(
      base({ state, plans: [plan()], hasVerifyVerdict: true, hasReviewCompleted: true, hasPrCreated: true }),
    ),
    "shipped",
  );
});

test("shipped: pr_created with no pr_review checkpoint recorded at all", () => {
  assert.equal(deriveBoardStage(base({ hasPrCreated: true })), "shipped");
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
