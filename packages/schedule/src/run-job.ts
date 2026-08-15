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
 */

import { writeJobStatus } from "./status-store.js";
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
  } catch (err: any) {
    const now = Date.now();
    status = {
      name: job.name,
      lastRunAt: new Date(now).toISOString(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message : String(err),
      lastDurationMs: now - startedAt,
      nextDueAt: new Date(now + job.intervalMs).toISOString(),
    };
  }

  try {
    await writeJobStatus(statusDir, status);
  } catch {
    // Even a failure to durably persist the status must not crash the
    // loop -- the in-memory status is still returned to the caller (e.g.
    // an onTick observability hook), it just may not have made it to disk
    // this cycle. A future successful write will catch the store up.
  }

  return status;
}
