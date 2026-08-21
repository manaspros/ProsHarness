/**
 * Pure logic: derive a single human-facing status label for a run from its
 * RunState. Deliberately does not import React/Next -- kept a plain
 * function so it's trivially unit-testable (see test/run-status.test.ts).
 *
 * NOTE on AttemptRecord.phase: per packages/barrier/src/run-state.ts's
 * projectRunState, an AttemptRecord's `phase` field is set to "running" at
 * attempt_started and is NEVER updated afterwards -- only `endedReason` is
 * set by attempt_ended. So "is this attempt still actually running" must be
 * read from `endedReason === undefined`, not from `phase`; treating `phase`
 * as live status here would be a bug (it always reads "running").
 */
import type { RunState } from "@pros/barrier";

export type RunStatusLabel =
  | "parked_awaiting_plan_approval"
  | "parked_awaiting_answer"
  | "parked_other"
  | "running"
  | "idle"
  | "done";

export function deriveRunStatus(state: RunState): RunStatusLabel {
  // A parked checkpoint (of either gate type) is the most actionable state
  // and takes priority over "an attempt is nominally running" -- by the time
  // a checkpoint is parked, its attempt has already ended (see barrier.ts's
  // proceedCheckpoint, which calls endAttempt right after appending
  // `parked`), so there is no real conflict, but checking parked first keeps
  // this correct even against a future journal shape where that ordering
  // changes.
  for (const cp of state.checkpoints.values()) {
    if (cp.phase === "parked") {
      if (cp.gateType === "plan_approval") return "parked_awaiting_plan_approval";
      if (cp.gateType === "ask_human" || cp.gateType === undefined) return "parked_awaiting_answer";
      return "parked_other";
    }
  }

  for (const a of state.attempts.values()) {
    if (a.endedReason === undefined) return "running";
  }

  if (state.attempts.size === 0 && state.checkpoints.size === 0) return "idle";

  return "done";
}

export const RUN_STATUS_LABELS: Record<RunStatusLabel, string> = {
  parked_awaiting_plan_approval: "Parked -- awaiting Gate 1 (plan approval)",
  parked_awaiting_answer: "Parked -- awaiting answer",
  parked_other: "Parked",
  running: "Running",
  idle: "Idle (no attempts yet)",
  done: "Done (all attempts ended, nothing parked)",
};

/**
 * B9: `deriveRunStatus` above answers "is an attempt live per the journal"
 * but the journal only records attempt_started/attempt_ended -- it has no
 * signal for "is the live subprocess still actually doing anything." A
 * session can be alive (no attempt_ended yet) but wedged on a single hung
 * tool call, and that failure mode is invisible to journal-only status.
 *
 * The signal that actually exists for this, without inventing new durable
 * state (CLAUDE.md: "the journal is the source of truth" -- liveness is
 * deliberately NOT a journal event, see board-data.ts's I/O half of this):
 * every subprocess line is teed verbatim to `<runDir>/attempts/<attemptId>/
 * raw.log` (packages/adapters/src/spawn-common.ts). A live, healthy session
 * keeps appending to that file; a wedged one stops. So "time since raw.log's
 * mtime last moved" is a real, cheap, already-collected liveness proxy.
 *
 * Threshold rationale: 90 seconds. It must clear ordinary quiet gaps inside
 * one tool call (a slow `pnpm test`, a multi-file Edit round-trip) without
 * being so long that "possibly wedged" lags what a human watching would
 * already suspect. Chosen relative to the scheduler's own polling cadence
 * for the closest analogous "how long is too long to wait" call in this
 * repo -- packages/schedule/src/jobs.ts's Gate-1-continuation job polls
 * every 2 minutes, i.e. a human would already refresh the dashboard again in
 * that same window. Half of that (90s) flags a stall inside the FIRST such
 * window rather than waiting for a second poll to confirm it. A named
 * constant, not a magic number, precisely so this reasoning is attached to
 * it and future tuning has a single place to change.
 */
export const STALE_RAW_LOG_THRESHOLD_MS = 90_000;

export type LivenessLabel = "active" | "stale" | "n/a";

/** Pure: the attemptId of the currently-running attempt, if any -- same "endedReason undefined" test deriveRunStatus's "running" branch uses, extracted so board-data.ts's I/O layer can look up that one attempt's raw.log without duplicating the loop. */
export function findRunningAttemptId(state: RunState): string | undefined {
  for (const a of state.attempts.values()) {
    if (a.endedReason === undefined) return a.attemptId;
  }
  return undefined;
}

/**
 * Pure: given the mtime (ms since epoch) of the running attempt's raw.log
 * (undefined if there is no running attempt, or its raw.log doesn't exist
 * yet -- e.g. the subprocess was just spawned and hasn't written its first
 * line), decide whether it looks actively producing output or looks
 * wedged. `now` is injectable so tests don't depend on wall-clock timing.
 */
export function deriveLiveness(rawLogMtimeMs: number | undefined, now: number = Date.now()): LivenessLabel {
  if (rawLogMtimeMs === undefined) return "n/a";
  return now - rawLogMtimeMs > STALE_RAW_LOG_THRESHOLD_MS ? "stale" : "active";
}
