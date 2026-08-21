/**
 * The core "failures surface, never silently stop" mechanism (M7 brief).
 *
 * `runJobOnce` itself must NEVER throw -- a failing job must not crash
 * whatever's driving the loop. Instead, a thrown error from `job.run()` is
 * caught here and durably recorded as `lastStatus: "error"` with the REAL
 * thrown message (never a generic "something went wrong", never swallowed
 * into nothing). Crucially, `lastRunAt` is still updated on failure -- the
 * attempt happened, even though it failed -- which is what makes the
 * failure observable rather than looking like "never ran". `nextDueAt`
 * still advances by a full `intervalMs` so a broken job doesn't spin the
 * loop hot or hang forever; it just gets retried next cycle, same as a
 * successful job.
 *
 * A status-write failure is itself a scheduler failure. It is returned as an
 * in-memory error status (and retried once as an error record) so callers and
 * observability hooks cannot mistake a successful job with lost persistence
 * for an overall success.
 */

import { writeJobStatus } from "./status-store.js";
import { ScheduledJobError } from "./types.js";
import type { JobStatus, ScheduledJob } from "./types.js";

export async function runJobOnce(job: ScheduledJob, statusDir: string): Promise<JobStatus> {
  const startedAt = Date.now();
  let status: JobStatus;

  try {
    const summary = await job.run();
    const now = Date.now();
    status = {
      name: job.name,
      lastRunAt: new Date(now).toISOString(),
      lastStatus: "ok",
      lastSummary: summary,
      lastDurationMs: now - startedAt,
      nextDueAt: new Date(now + job.intervalMs).toISOString(),
    };
  } catch (err: unknown) {
    const now = Date.now();
    status = {
      name: job.name,
      lastRunAt: new Date(now).toISOString(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message : String(err),
      lastDurationMs: now - startedAt,
      nextDueAt: new Date(now + job.intervalMs).toISOString(),
      ...(err instanceof ScheduledJobError ? { lastSummary: err.summary } : {}),
    };
  }

  try {
    await writeJobStatus(statusDir, status);
  } catch (err: unknown) {
    const persistenceError = err instanceof Error ? err.message : String(err);
    const originalError = status.lastStatus === "error" ? status.lastError : undefined;
    const failedStatus: JobStatus = {
      name: status.name,
      lastRunAt: status.lastRunAt,
      lastStatus: "error",
      lastError: originalError
        ? `${originalError}; failed to persist scheduler status: ${persistenceError}`
        : `failed to persist scheduler status: ${persistenceError}`,
      lastDurationMs: status.lastDurationMs,
      nextDueAt: status.nextDueAt,
      ...(status.lastSummary ? { lastSummary: status.lastSummary } : {}),
    };

    // A transient failure may be recoverable after the first attempt, but the
    // returned status remains error even if this best-effort retry succeeds.
    status = failedStatus;
    await writeJobStatus(statusDir, failedStatus).catch(() => undefined);
  }

  return status;
}
