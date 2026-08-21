/**
 * "Unknown/unparsed events must surface in the UI" -- the M3 acceptance
 * criterion this file exists for: "a run that silently dropped a
 * verification failed event must never look healthy."
 *
 * Two independent sources of "this run's history might be incomplete or
 * unparseable", both surfaced, never merged into a single fuzzy signal:
 *
 *   1. RebuildReport.rawLogParseIssues / .truncatedRuns -- from
 *      @pros/index's rebuildIndex, already computed for us.
 *   2. Journal entries whose `kind` isn't one this dashboard's copy of
 *      @pros/barrier recognizes. TypeScript's JournalEntry union is a
 *      *compile-time* closed set; nothing stops a future/foreign writer
 *      putting an unrecognized `kind` on disk, and
 *      packages/barrier/src/run-state.ts's projectRunState silently no-ops
 *      unrecognized kinds via its `default: break`. @pros/index's `events`
 *      table captures one row per journal entry regardless of kind (see
 *      schema.ts's doc comment: `is_unknown` is hard-coded 0 for
 *      journal-derived rows -- the index package does NOT do this
 *      detection for us), so we do it here: compare the set of `kind`
 *      values actually present for a run against KNOWN_JOURNAL_KINDS.
 *
 * All pure/testable except queryUnknownJournalKinds, which is a thin,
 * direct SQL query against the schema in packages/index/src/schema.ts (no
 * existing helper exports this).
 */
import type Database from "better-sqlite3";
import type { RebuildReport } from "@pros/index";

/** Every JournalEntry["kind"] literal from packages/barrier/src/types.ts, kept in sync by hand -- there is no runtime-derivable list from a TS union. */
export const KNOWN_JOURNAL_KINDS: ReadonlySet<string> = new Set([
  "attempt_started",
  "attempt_ended",
  "checkpoint_requested",
  "quiescing",
  "parked",
  "answered",
  "claimed",
  "resuming",
  "consumed",
  "fence_bumped",
  "checkpoint_deferred",
  "safe_section_enter",
  "safe_section_exit",
  "rejected_stale",
  "worktree_intent",
  "worktree_allocated",
  "worktree_confirmed",
  "worktree_rollback",
  // Fresh-workspace-per-session (fetch + remote-default-branch resolution),
  // written by packages/plan/src/pipeline.ts BEFORE worktree_intent.
  "workspace_base_resolved",
  "finding_recorded",
  "model_session_recorded",
  "plan_operation_started",
  "plan_operation_completed",
  "plan_drafted",
  "critique_independent",
  "critique_objections",
  "plan_revised",
  "debate_capped",
  "plan_finalized",
  "plan_edited",
  "hook_payload_received",
  // Written by packages/implement's Gate 2 / M4 pipeline (src/pipeline.ts),
  // not (yet) part of @pros/barrier's JournalEntry union -- this dashboard's
  // board-data.ts and review-data.ts already understand and render these.
  "verify_verdict",
  "review_completed",
  "pr_create_intent",
  "pr_created",
  // Phase 3: one event per harness-spawned validation command (packages/
  // implement's verify.ts / pipeline.ts) -- see packages/implement/src/
  // validation-commands.ts's CheckResult for the shape this is derived from.
  "validation_command_run",
  // Phase 6: the SEPARATE, advisory-only Codex pass (packages/implement's
  // review.ts's runCodexAdvisoryReview, wired in pipeline.ts) -- distinct
  // from "review_completed" above, which is the still-gating claude+codex
  // objections review. Never gates anything; status is one of
  // "reviewed_no_blocker" | "reviewed_blocker" | "unavailable".
  "codex_advisory_review",
]);

export interface HealthIssue {
  kind: "raw_log_parse_issue" | "truncated_journal" | "unknown_journal_kind";
  detail: string;
}

/** Pure: given a RebuildReport and (optionally) whether loadRunState itself flagged truncation for this run, compute the health issue list for one run id. */
export function rebuildHealthIssues(runId: string, report: RebuildReport, runStateTruncated?: boolean): HealthIssue[] {
  const issues: HealthIssue[] = [];

  for (const i of report.rawLogParseIssues) {
    if (i.runId !== runId) continue;
    issues.push({
      kind: "raw_log_parse_issue",
      detail: `attempt ${i.attemptId} seq ${i.seq}: raw log line is ${i.status === "malformed" ? "malformed JSON" : "an unrecognized event type"}`,
    });
  }

  if (report.truncatedRuns.includes(runId) || runStateTruncated) {
    issues.push({
      kind: "truncated_journal",
      detail: "journal.ndjson has a torn/corrupt tail (checksum or length mismatch) -- some events may be missing",
    });
  }

  return issues;
}

/** Pure: given the distinct kinds actually present for a run's journal, which ones are unrecognized by this dashboard's @pros/barrier. */
export function unknownJournalKinds(kindsPresent: string[]): string[] {
  return kindsPresent.filter((k) => !KNOWN_JOURNAL_KINDS.has(k));
}

export function isHealthy(issues: HealthIssue[]): boolean {
  return issues.length === 0;
}

/**
 * Direct SQL against @pros/index's `events` table (schema.ts) -- there is no
 * exported helper for "distinct kinds present for a run", so this is written
 * against the schema directly, per the brief.
 */
export function queryUnknownJournalKinds(db: Database.Database, runId: string): string[] {
  const rows = db.prepare(`SELECT DISTINCT kind FROM events WHERE run_id = ?`).all(runId) as Array<{ kind: string }>;
  return unknownJournalKinds(rows.map((r) => r.kind));
}
