/**
 * The scheduler loop. Simplicity over throughput, matching @pros/triggers'
 * own choice: on a single `setInterval(pollIntervalMs)`, every due job is
 * run sequentially via `runJobOnce` (never in parallel -- one job's slow
 * run just delays the others' due-check until the next check, it never
 * races them).
 *
 * `isDue` is exported separately as a pure function so it can be unit
 * tested exhaustively without any real or fake timers.
 */

import { readJobStatus } from "./status-store.js";
import { runJobOnce } from "./run-job.js";
import type { JobStatus, ScheduledJob } from "./types.js";

/** Pure: a job is due if it has never run, or if `now >= lastRunAt + intervalMs`. */
export function isDue(status: JobStatus, intervalMs: number, now: number = Date.now()): boolean {
  if (!status.lastRunAt) return true;
  const lastRunMs = Date.parse(status.lastRunAt);
  if (Number.isNaN(lastRunMs)) return true;
  return now >= lastRunMs + intervalMs;
}

export interface SchedulerLoopOptions {
  jobs: ScheduledJob[];
  statusDir: string;
  /** How often the loop wakes to check what's due. Default 30_000ms. */
  pollIntervalMs?: number;
  /** Optional observability hook, called once per poll tick with every job's current status (whether or not it ran this tick). Useful for tests -- inject a spy instead of waiting on wall-clock timers. */
  onTick?: (statuses: JobStatus[]) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function startSchedulerLoop(opts: SchedulerLoopOptions): { stop: () => void } {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return; // a previous tick is still running (e.g. a slow job) -- skip, don't overlap
    ticking = true;
    try {
      const now = Date.now();
      for (const job of opts.jobs) {
        const status = await readJobStatus(opts.statusDir, job.name);
        if (isDue(status, job.intervalMs, now)) {
          await runJobOnce(job, opts.statusDir);
        }
      }
      if (opts.onTick) {
        const statuses: JobStatus[] = [];
        for (const job of opts.jobs) {
          statuses.push(await readJobStatus(opts.statusDir, job.name));
        }
        opts.onTick(statuses);
      }
    } finally {
      ticking = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}
