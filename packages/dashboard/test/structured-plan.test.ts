import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStructuredPlan } from "../lib/structured-plan.js";

test("null/undefined/empty structured_json degrades to undefined, never throws", () => {
  assert.equal(parseStructuredPlan(null), undefined);
  assert.equal(parseStructuredPlan(undefined), undefined);
  assert.equal(parseStructuredPlan(""), undefined);
});

test("malformed JSON degrades to undefined, never throws", () => {
  assert.equal(parseStructuredPlan("{not json"), undefined);
});

test("a pre-Phase-5a plan (no diagram/claim) parses with both undefined -- the graceful-degrade case", () => {
  const json = JSON.stringify({ steps: ["do a thing"], filesTouched: ["a.ts"], risk: "low" });
  const parsed = parseStructuredPlan(json);
  assert.ok(parsed);
  assert.deepEqual(parsed!.steps, ["do a thing"]);
  assert.deepEqual(parsed!.filesTouched, ["a.ts"]);
  assert.equal(parsed!.risk, "low");
  assert.equal(parsed!.diagram, undefined);
  assert.equal(parsed!.claim, undefined);
});

test("a full Phase-5a plan carries diagram and claim through", () => {
  const json = JSON.stringify({
    steps: ["x"],
    filesTouched: ["y.ts"],
    risk: "medium",
    diagram: "flowchart TD\nA-->B",
    claim: "This makes the button clickable again.",
  });
  const parsed = parseStructuredPlan(json);
  assert.equal(parsed!.diagram, "flowchart TD\nA-->B");
  assert.equal(parsed!.claim, "This makes the button clickable again.");
});

test("a blank/whitespace-only diagram or claim is treated as absent, not as an empty box", () => {
  const json = JSON.stringify({ steps: [], filesTouched: [], risk: "", diagram: "   ", claim: "" });
  const parsed = parseStructuredPlan(json);
  assert.equal(parsed!.diagram, undefined);
  assert.equal(parsed!.claim, undefined);
});

test("non-object JSON (e.g. a bare string or array) degrades to undefined", () => {
  assert.equal(parseStructuredPlan(JSON.stringify("just a string")), undefined);
  assert.equal(parseStructuredPlan(JSON.stringify([1, 2, 3])), undefined);
});

test("non-array steps/filesTouched fields are dropped, not thrown -- defensive against a malformed field", () => {
  const json = JSON.stringify({ steps: "not an array", filesTouched: 5, risk: "low" });
  const parsed = parseStructuredPlan(json);
  assert.deepEqual(parsed!.steps, []);
  assert.deepEqual(parsed!.filesTouched, []);
});
