import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCurrentPlan, type PlanRowLike } from "../lib/plan-doc.js";

function row(overrides: Partial<PlanRowLike>): PlanRowLike {
  return {
    version: 1,
    markdown: "md",
    plan_id: "plan-1",
    state: "drafted",
    edited_at: null,
    edited_by: null,
    ...overrides,
  };
}

test("no plans -> undefined", () => {
  assert.equal(resolveCurrentPlan([]), undefined);
});

test("a single plan version is current", () => {
  const p = row({ version: 1, markdown: "hello" });
  assert.equal(resolveCurrentPlan([p]), p);
});

test("the highest version wins, regardless of array order", () => {
  const v1 = row({ version: 1, markdown: "draft" });
  const v2 = row({ version: 2, markdown: "revised" });
  const v3 = row({ version: 3, markdown: "finalized" });
  assert.equal(resolveCurrentPlan([v2, v3, v1]), v3);
  assert.equal(resolveCurrentPlan([v1, v2, v3]), v3);
});

test("an edited plan's markdown is already resolved into the row -- edited_at/edited_by just annotate it", () => {
  // Mirrors packages/index/src/rebuild.ts's plan_edited handling: it mutates
  // the SAME version's row in place, so the current-version row's markdown
  // already reflects the edit. resolveCurrentPlan need not treat edited
  // plans specially -- it just needs to pick the highest version.
  const edited = row({
    version: 2,
    markdown: "edited text",
    edited_at: "2026-08-15T00:00:00Z",
    edited_by: "human",
  });
  const older = row({ version: 1, markdown: "original draft" });
  const current = resolveCurrentPlan([older, edited]);
  assert.equal(current?.markdown, "edited text");
  assert.equal(current?.edited_by, "human");
});
