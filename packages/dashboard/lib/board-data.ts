/**
 * Pure logic: bucket a run into a lifecycle-stage column for the home-page
 * Kanban board (app/page.tsx), richer than lib/run-status.ts's
 * `deriveRunStatus` alone provides. Follows the same "pure-logic-in-lib,
 * thin page component" convention as lib/run-status.ts / lib/plan-doc.ts,
 * so this is directly unit-testable (see test/board-data.test.ts) without a
 * running Next.js server.
 *
 * Inputs, and why each is needed beyond what deriveRunStatus already reads
 * from RunState:
 *   - RunState (checkpoints/attempts), same as deriveRunStatus.
 *   - The run's PlanRow[] (lib/index's getPlans) -- deriveRunStatus cannot
 *     tell "no attempts yet, nothing parked" (idle) apart from "actively
 *     finding/investigating before a plan exists" vs "plan drafted but not
 *     yet finalized" -- both collapse to "idle" in RunState terms because
 *     plan drafting/critique isn't attempt/checkpoint activity.
 *   - Whether a verify_verdict / review_completed / pr_created event exists
 *     (Gate 2 events -- see lib/review-data.ts's file comment for why these
 *     live in the `events` table under those exact `kind` values). These
 *     have no RunState/checkpoint representation of their own except the
 *     final pr_review checkpoint.
 *
 * STAGE ORDER (left-to-right column order on the board), most-advanced-first
 * priority when picking ONE bucket per run -- mirrors deriveRunStatus's own
 * "parked checks first" priority discipline:
 *
 *   1. shipped        -- has pr_created AND the pr_review checkpoint (if
 *                         any) is no longer parked (human has answered
 *                         "reviewed"). See "On 'merged' vs honesty" below --
 *                         this column is deliberately NOT labelled "merged".
 *   2. awaiting_gate2  -- has pr_created AND its pr_review checkpoint is
 *                         still parked: draft PR is open, waiting on the
 *                         human's Gate 2 decision (review + merge, done
 *                         entirely outside this system -- see below).
 *   3. verifying       -- has a verify_verdict event but no review_completed
 *                         event yet. Chosen dividing line (documented per
 *                         the brief's "document your choice" convention,
 *                         same as lib/review-data.ts): per
 *                         packages/implement's Gate 2 pipeline order
 *                         (verify -> review -> draft PR -> park), a run with
 *                         a verdict but no review result is, by construction,
 *                         between those two steps right now. We do NOT also
 *                         try to detect "attempts running post-approval, no
 *                         verdict yet" as a distinct earlier verifying state
 *                         (the brief's alternative reading) because
 *                         RunState's `attempts` map is empty for both demo
 *                         runs even after real Gate 1/Gate 2 pipeline work
 *                         happened on them -- this dashboard's synthetic/
 *                         demo journals do not emit attempt_started/ended
 *                         for the gate pipelines themselves, only for real
 *                         subprocess launches, so "an attempt is running" is
 *                         not a reliable signal to distinguish
 *                         implementing-vs-verifying. `implementing` (below)
 *                         is therefore "approved, no verdict yet" as a
 *                         whole, and `verifying` only starts once a verdict
 *                         actually exists.
 *   4. awaiting_gate1  -- deriveRunStatus === "parked_awaiting_plan_approval"
 *                         (a checkpoint parked with gateType "plan_approval").
 *   5. implementing    -- the plan_approval checkpoint exists and is NOT
 *                         parked (i.e. it was answered -- approved or
 *                         amended-and-continued) but no verify_verdict
 *                         exists yet. This is "past Gate 1, Gate 2 not
 *                         resolved yet" as a whole (see `verifying` above
 *                         for why we don't subdivide it further).
 *   6. planning        -- at least one PlanRow exists for the run (a plan
 *                         has been drafted, possibly through several
 *                         critique/revision rounds) but no plan_approval
 *                         checkpoint exists yet at all.
 *   7. finding         -- no PlanRow exists yet. Covers both a genuinely
 *                         idle/fresh run and one with a running attempt
 *                         still investigating before drafting a plan.
 *
 * On "merged" vs honesty (per the brief's "get this right, don't overclaim"):
 * docs/07-m4-implementation-log.md's "the merge boundary" section is
 * explicit that this system NEVER merges a PR -- the PR is opened with a
 * scoped, deliberately unmerge-capable credential, specifically so a human
 * must merge it themselves on GitHub. Nothing in this journal/event model
 * (see KNOWN_JOURNAL_KINDS in lib/health.ts, and the three Gate-2 event
 * kinds review-data.ts documents) records an actual merge -- the LAST thing
 * this system ever journals for a run is the human answering the pr_review
 * checkpoint ("reviewed"), which happens after they've looked at (and,
 * presumably, merged) the PR on GitHub, entirely outside this system's
 * visibility. So this board's terminal column is labelled `"PR opened"`,
 * not `"Merged"` (see STAGE_LABELS) -- claiming "merged" would assert
 * something this data model cannot actually see.
 */
import type Database from "better-sqlite3";
import type { RunState } from "@pros/barrier";
import type { PlanRow, ObjectionRow } from "@pros/index";
import { resolveCurrentPlan } from "./plan-doc.js";

export type BoardStage =
  | "finding"
  | "planning"
  | "awaiting_gate1"
  | "implementing"
  | "verifying"
  | "awaiting_gate2"
  | "shipped";

/** Left-to-right column order for the board. */
export const BOARD_STAGES: BoardStage[] = [
  "finding",
  "planning",
  "awaiting_gate1",
  "implementing",
  "verifying",
  "awaiting_gate2",
  "shipped",
];

export const STAGE_LABELS: Record<BoardStage, string> = {
  finding: "Finding",
  planning: "Planning",
  awaiting_gate1: "Awaiting Gate 1",
  implementing: "Implementing",
  verifying: "Verifying",
  awaiting_gate2: "Awaiting Gate 2",
  // Deliberately not "Merged" -- see the file-level comment "On 'merged' vs
  // honesty": this system never observes an actual merge, only the human's
  // "reviewed" answer after they've handled the PR on GitHub themselves.
  shipped: "PR opened",
};

export interface BoardStageInputs {
  state: RunState;
  plans: PlanRow[];
  hasVerifyVerdict: boolean;
  hasReviewCompleted: boolean;
  hasPrCreated: boolean;
}

/** Pure: bucket one run into a single BoardStage. See file-level comment for the full priority order and reasoning. */
export function deriveBoardStage(inputs: BoardStageInputs): BoardStage {
  const { state, plans, hasVerifyVerdict, hasReviewCompleted, hasPrCreated } = inputs;

  const planApprovalCp = [...state.checkpoints.values()].find((cp) => cp.gateType === "plan_approval");
  const prReviewCp = [...state.checkpoints.values()].find((cp) => cp.gateType === "pr_review");

  if (hasPrCreated) {
    if (prReviewCp && prReviewCp.phase === "parked") return "awaiting_gate2";
    return "shipped";
  }

  if (hasVerifyVerdict && !hasReviewCompleted) return "verifying";

  if (hasVerifyVerdict) {
    // Verdict + review both exist but no PR yet (e.g. review found
    // blockers and a PR was never drafted, or draft-PR creation hasn't run
    // yet) -- still "awaiting" a Gate 2 outcome.
    return "awaiting_gate2";
  }

  if (planApprovalCp) {
    if (planApprovalCp.phase === "parked") return "awaiting_gate1";
    return "implementing";
  }

  if (plans.length > 0) return "planning";

  return "finding";
}

/** Pure: unresolved objections (any round) for a run's CURRENT plan version, most-severe-first-ish is left to the caller -- this just filters. */
export function unresolvedObjections(objections: ObjectionRow[]): ObjectionRow[] {
  return objections.filter((o) => o.resolution === "unresolved" || o.resolution === null);
}

export function hasMajorUnresolved(objections: ObjectionRow[]): boolean {
  return unresolvedObjections(objections).some((o) => o.severity === "major");
}

/** Re-exported for callers that already have a run's PlanRow[] and want "is there a plan yet" without re-deriving it. */
export { resolveCurrentPlan };

/**
 * Direct SQL against @pros/index's `events` table (no existing helper
 * exports "last activity timestamp for a run"): every JournalEntry carries
 * a `ts` field (JournalEntryBase in packages/barrier/src/types.ts), and
 * @pros/index's rebuildIndex stores each entry's full JSON as
 * `payload_json` regardless of kind (see lib/review-data.ts's file
 * comment) -- so the highest-`seq` row's payload_json, parsed, has a `ts`
 * we can use as "last time anything happened on this run" for the board
 * card's relative timestamp. Returns undefined if the run has no events
 * yet (brand new, nothing journalled).
 */
/** Pure: format an ISO timestamp as a short "Xago" relative string for board cards. `now` is injectable for tests. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (!Number.isFinite(diffMs)) return iso;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return diffSec <= 0 ? "just now" : `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

export function getLastEventTimestamp(db: Database.Database, runId: string): string | undefined {
  const row = db
    .prepare(`SELECT payload_json FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.payload_json) as { ts?: unknown };
    return typeof parsed.ts === "string" ? parsed.ts : undefined;
  } catch {
    return undefined;
  }
}
