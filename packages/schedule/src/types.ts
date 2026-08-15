/**
 * The M7 scheduler's core shapes -- "whatever drives the periodic sweep and
 * the weekly skill pass" per the M7 brief. Kept deliberately simple and
 * observable: a job is just a name, an interval, and an async function that
 * returns a small JSON-serializable summary. Failures must surface, not
 * silently stop -- see run-job.ts for the mechanism that guarantees this.
 */

export interface JobRunSummary {
  [key: string]: unknown;
}

export interface ScheduledJob {
  /** e.g. "trigger-sweep", "skillrank-weekly". */
  name: string;
  /** How often this job is due, in milliseconds. */
  intervalMs: number;
  /** Must not throw for expected/degraded conditions -- see run-job.ts's doc comment for what "must not throw" actually means here (it CAN throw; run-job.ts is what catches it). */
  run: () => Promise<JobRunSummary>;
}

export interface JobStatus {
  name: string;
  /** ISO, undefined if never run. */
  lastRunAt?: string;
  lastStatus: "ok" | "error" | "never-run";
  /** Set iff lastStatus === "error" -- the actual thrown error's message, never swallowed. */
  lastError?: string;
  lastSummary?: JobRunSummary;
  lastDurationMs?: number;
  /** Computed from lastRunAt + intervalMs (or "now" if never run). */
  nextDueAt?: string;
}
