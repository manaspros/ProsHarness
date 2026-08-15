import { test } from "node:test";
import assert from "node:assert/strict";
import { rebuildHealthIssues, unknownJournalKinds, isHealthy, KNOWN_JOURNAL_KINDS } from "../lib/health.js";
import type { RebuildReport } from "@pros/index";

function emptyReport(overrides: Partial<RebuildReport> = {}): RebuildReport {
  return {
    runsProcessed: 0,
    truncatedRuns: [],
    rawEventsInserted: 0,
    eventsInserted: 0,
    plansInserted: 0,
    objectionsInserted: 0,
    findingsInserted: 0,
    worktreesInserted: 0,
    rawLogParseIssues: [],
    ...overrides,
  };
}

test("a run with a clean report and no unknown kinds is healthy", () => {
  const issues = rebuildHealthIssues("run-a", emptyReport());
  assert.equal(isHealthy(issues), true);
});

test("a run with a raw log parse issue for a DIFFERENT run is unaffected", () => {
  const report = emptyReport({
    rawLogParseIssues: [{ runId: "run-b", attemptId: "att1", seq: 3, status: "unknown_type" }],
  });
  assert.equal(isHealthy(rebuildHealthIssues("run-a", report)), true);
  assert.equal(isHealthy(rebuildHealthIssues("run-b", report)), false);
});

test("malformed and unknown_type raw log lines both surface as unhealthy", () => {
  const report = emptyReport({
    rawLogParseIssues: [
      { runId: "run-a", attemptId: "att1", seq: 0, status: "malformed" },
      { runId: "run-a", attemptId: "att1", seq: 1, status: "unknown_type" },
    ],
  });
  const issues = rebuildHealthIssues("run-a", report);
  assert.equal(issues.length, 2);
  assert.equal(isHealthy(issues), false);
});

test("a run listed in truncatedRuns is unhealthy", () => {
  const report = emptyReport({ truncatedRuns: ["run-a"] });
  assert.equal(isHealthy(rebuildHealthIssues("run-a", report)), false);
});

test("a run whose own loadRunState reported truncation is unhealthy even if not in the RebuildReport's truncatedRuns", () => {
  // Defensive: don't rely SOLELY on the index's view -- a fresh loadRunState
  // call against the run directly (e.g. on the run detail page) might see
  // truncation the last index rebuild didn't capture (race between the two
  // reads of the journal).
  const issues = rebuildHealthIssues("run-a", emptyReport(), /* runStateTruncated */ true);
  assert.equal(isHealthy(issues), false);
});

test("unknownJournalKinds: filters out everything in KNOWN_JOURNAL_KINDS", () => {
  const present = [...KNOWN_JOURNAL_KINDS, "some_future_kind", "another_unknown"];
  const unknown = unknownJournalKinds(present);
  assert.deepEqual(unknown.sort(), ["another_unknown", "some_future_kind"]);
});

test("unknownJournalKinds: empty when every kind present is known", () => {
  assert.deepEqual(unknownJournalKinds(["attempt_started", "parked", "plan_edited"]), []);
});
