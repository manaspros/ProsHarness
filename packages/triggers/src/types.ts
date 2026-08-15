/**
 * The ambient trigger framework's core shapes (M7, docs/00-decisions.md D7).
 *
 * D7: "Triggers: manual first, then Linear, Slack, scheduled sweep, Granola.
 * All normalize to one trigger interface." This file is that interface.
 *
 * Every field is deliberately generic across sources rather than named after
 * any one of them (no `issueId`, no `messageTs`) so `runner.ts` and
 * `admit.ts` never need to know which source a signal came from to process
 * it -- only `dedup.ts`'s hash and the source adapters themselves care about
 * source-specific shapes.
 */

/** Known file:line evidence a source already has for a signal, if any. `sweep` always sets this since it IS a file:line scan; other sources normally don't. */
export interface SignalEvidence {
  file: string;
  line: number;
}

export interface Signal {
  /** The source's own id, e.g. "linear" | "slack" | "sweep" | "granola". */
  sourceId: string;
  /** Stable id from the source system (issue id, message ts, todo hash, note id + action-item index). Combined with sourceId, this is the dedup key -- see dedup.ts. */
  externalId: string;
  /** e.g. "issue" | "message" | "todo" | "action-item". */
  kind: string;
  title: string;
  body: string;
  /**
   * Link back to the source item, for a human's reference only.
   * NEVER used to write or post anything -- read-only, see the READ-ONLY
   * ADAPTER banner in every file under src/sources/.
   */
  url?: string;
  /** ISO timestamp of when the underlying item was raised/created. */
  raisedAt: string;
  /** When the source itself already knows a file:line (sweep always sets this), so the description handed to the plan pipeline can give the finding a head start. */
  evidence?: SignalEvidence;
}

export interface TriggerSource {
  readonly id: string;
  /**
   * Must never throw for "expected" unavailability (missing config) --
   * return [] in that case. May throw for genuine bugs (e.g. malformed
   * fixture JSON), which the runner catches and records as a source failure
   * without affecting other sources.
   */
  fetchSignals(): Promise<Signal[]>;
}
