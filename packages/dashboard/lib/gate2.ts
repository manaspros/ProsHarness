import type { RunState } from "@pros/barrier";

export const GATE2_STOPPED_PREFIX = "Gate 2 stopped";

export interface Gate2PipelineResultLike {
  aborted?: { stage: "verify" | "review"; reason: string };
  pr?: { url: string; number: number; headSha: string };
}

export interface OperationCompletion {
  transition: "success" | "failed";
  error?: string;
}

export interface Gate2OperationStatusLike {
  operation?: string;
  state?: string;
  error?: string;
  result?: Gate2PipelineResultLike;
}

export type Gate2ReviewDecision = "awaiting_review" | "reviewed" | "invalid_answer" | "not_recorded";

/** The only Gate 2 answer that is a successful human review. */
export function gate2ReviewDecision(checkpoint: { phase?: string; answer?: string; effect?: string } | undefined): Gate2ReviewDecision {
  if (!checkpoint) return "not_recorded";
  if (checkpoint.phase === "parked") return "awaiting_review";
  if (checkpoint.phase === "answered" && checkpoint.answer === "reviewed" && checkpoint.effect === "continue_within_approved_plan") {
    return "reviewed";
  }
  if (checkpoint.phase === "answered") return "invalid_answer";
  return "not_recorded";
}

/** Convert the implement package's resolved result into a durable dashboard operation outcome. */
export function gate2OperationCompletion(result: Gate2PipelineResultLike): OperationCompletion {
  if (!result.aborted) return { transition: "success" };
  return {
    transition: "failed",
    error: formatGate2StoppedError(`during ${result.aborted.stage}: ${result.aborted.reason}`),
  };
}

/** Identify a resolved/stored Gate 2 stop without conflating it with a thrown failure. */
export function isGate2StoppedOperation(operation: Gate2OperationStatusLike | undefined): boolean {
  return operation?.operation === "implementation" &&
    (operation.state === "stopped" || Boolean(operation.result?.aborted) || isGate2StoppedError(operation.error));
}

export function isGate2StoppedError(error: string | undefined): boolean {
  return typeof error === "string" && error.trim().startsWith(GATE2_STOPPED_PREFIX);
}

export function formatGate2StoppedError(error: string | undefined): string {
  const detail = error?.trim();
  if (!detail) return `${GATE2_STOPPED_PREFIX} without an error message`;
  return isGate2StoppedError(detail) ? detail : `${GATE2_STOPPED_PREFIX}: ${detail}`;
}

export function parkedGate2Checkpoint(state: RunState) {
  return [...state.checkpoints.values()].find((checkpoint) => checkpoint.gateType === "pr_review" && checkpoint.phase === "parked");
}
