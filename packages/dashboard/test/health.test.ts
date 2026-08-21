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

// --- Phase 3: validation_command_run ---------------------------------------

test("validation_command_run (Phase 3's harness-spawned check event) is a recognized journal kind", () => {
  assert.ok(KNOWN_JOURNAL_KINDS.has("validation_command_run"));
  assert.deepEqual(unknownJournalKinds(["validation_command_run"]), []);
});

// --- Phase 6: codex_advisory_review -----------------------------------------

test("codex_advisory_review (Phase 6's advisory-only Codex pass) is a recognized journal kind", () => {
  assert.ok(KNOWN_JOURNAL_KINDS.has("codex_advisory_review"));
  assert.deepEqual(unknownJournalKinds(["codex_advisory_review"]), []);
});

test("LOAD-BEARING INVARIANT: an unrecognized kind is unhealthy even when every other kind present -- including the new validation_command_run -- is known", () => {
  // Exercises the exact mechanism app/runs/[runId]/page.tsx uses: build a
  // HealthIssue per kind unknownJournalKinds() flags, then isHealthy() on
  // the full issue list. This must never quietly start reporting healthy
  // just because this phase extended KNOWN_JOURNAL_KINDS.
  const present = [...KNOWN_JOURNAL_KINDS, "a_kind_nobody_registered"];
  const unknown = unknownJournalKinds(present);
  assert.deepEqual(unknown, ["a_kind_nobody_registered"]);
  const issues = unknown.map((k) => ({ kind: "unknown_journal_kind" as const, detail: `unrecognized journal kind: ${k}` }));
  assert.equal(isHealthy(issues), false, "an unrecognized kind must surface as unhealthy, never silently pass through");
});
