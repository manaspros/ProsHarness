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
