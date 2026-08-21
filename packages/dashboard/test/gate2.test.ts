import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGate2StoppedError,
  gate2OperationCompletion,
  gate2ReviewDecision,
  isGate2StoppedError,
  isGate2StoppedOperation,
} from "../lib/gate2.js";

test("a successful Gate 2 result records success", () => {
  assert.deepEqual(gate2OperationCompletion({}), { transition: "success" });
});

test("an aborted Gate 2 result records a stopped failure", () => {
  assert.deepEqual(
    gate2OperationCompletion({ aborted: { stage: "verify", reason: "tests failed" } }),
    { transition: "failed", error: "Gate 2 stopped: during verify: tests failed" },
  );
});

test("raw Gate 2 exceptions are normalized without losing their detail", () => {
  assert.equal(formatGate2StoppedError("gh auth failed"), "Gate 2 stopped: gh auth failed");
  assert.equal(formatGate2StoppedError("  "), "Gate 2 stopped without an error message");
  assert.equal(isGate2StoppedError("Gate 2 stopped: gh auth failed"), true);
  assert.equal(isGate2StoppedError("gh auth failed"), false);
});

test("failed and stopped implementation operations remain distinguishable", () => {
  assert.equal(isGate2StoppedOperation({ operation: "implementation", state: "failed" }), false);
  assert.equal(isGate2StoppedOperation({ operation: "implementation", state: "stopped" }), true);
  assert.equal(isGate2StoppedOperation({ operation: "implementation", state: "failed", error: "Gate 2 stopped: verify failed" }), true);
  assert.equal(isGate2StoppedOperation({ operation: "implementation", state: "running" }), false);
  assert.equal(isGate2StoppedOperation({ operation: "plan_pipeline", state: "failed" }), false);
});

test("only an answered reviewed Gate 2 checkpoint is a successful human review", () => {
  assert.equal(gate2ReviewDecision({ phase: "parked" }), "awaiting_review");
  assert.equal(
    gate2ReviewDecision({ phase: "answered", answer: "reviewed", effect: "continue_within_approved_plan" }),
    "reviewed",
  );
  assert.equal(gate2ReviewDecision({ phase: "answered", answer: "approved", effect: "continue_within_approved_plan" }), "invalid_answer");
  assert.equal(gate2ReviewDecision({ phase: "answered", answer: "reviewed", effect: "abort" }), "invalid_answer");
  assert.equal(gate2ReviewDecision(undefined), "not_recorded");
});
