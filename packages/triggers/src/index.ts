export type { Signal, SignalEvidence, TriggerSource } from "./types.js";

export type { ClaimResult, ClaimRecord } from "./dedup.js";
export { SignalDedupStore, signalDedupId, claimPathFor, readClaimRecord } from "./dedup.js";

export type {
  SourceFailure,
  AdmissionFailure,
  AdmissionContext,
  TriggerCycleResult,
  RunTriggerCycleOptions,
} from "./runner.js";
export { runTriggerCycle } from "./runner.js";

export type { RealAdmitOptions } from "./admit.js";
export { createRealOnNewSignal, withTokenCeiling, buildDescription } from "./admit.js";

export type { LinearIssueFixture, LinearSourceOptions } from "./sources/linear.js";
export { LinearSource } from "./sources/linear.js";
export type { SlackMessageFixture, SlackSourceOptions } from "./sources/slack.js";
export { SlackSource } from "./sources/slack.js";
export type { GranolaNoteFixture, GranolaSourceOptions } from "./sources/granola.js";
export { GranolaSource } from "./sources/granola.js";
export type { SweepSourceOptions } from "./sources/sweep.js";
export { SweepSource } from "./sources/sweep.js";
