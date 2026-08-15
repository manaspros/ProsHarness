import { test } from "node:test";
import assert from "node:assert/strict";
import { planActionToEffect, isAnswerEffect, ANSWER_EFFECTS, DEFAULT_ANSWER_EFFECT } from "../lib/gate-actions.js";

test("approve maps to continue_within_approved_plan", () => {
  assert.equal(planActionToEffect("approve"), "continue_within_approved_plan");
});

test("request_amendment maps to requires_plan_amendment", () => {
  assert.equal(planActionToEffect("request_amendment"), "requires_plan_amendment");
});

test("reject maps to abort", () => {
  assert.equal(planActionToEffect("reject"), "abort");
});

test("isAnswerEffect recognizes all three valid effects", () => {
  for (const e of ANSWER_EFFECTS) assert.equal(isAnswerEffect(e), true);
});

test("isAnswerEffect rejects garbage", () => {
  assert.equal(isAnswerEffect("not_a_real_effect"), false);
  assert.equal(isAnswerEffect(""), false);
});

test("default answer effect is continue_within_approved_plan", () => {
  assert.equal(DEFAULT_ANSWER_EFFECT, "continue_within_approved_plan");
});
