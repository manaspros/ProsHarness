/**
 * Data-shaping helpers for the M7 "scheduled jobs" page. Reads the
 * already-serialized status JSON files written by @pros/schedule's
 * `writeJobStatus` -- one file per job at `${statusDir}/<jobName>.json`.
 *
 * Per the M6 dashboard convention established by lib/loops-data.ts (which
 * deliberately avoids importing @pros/miner so the dashboard can be built
 * in parallel with, or independently of, the producing package), this
 * module does NOT import @pros/schedule either -- it re-implements a small
 * tolerant JSON reader against the same on-disk shape instead. This keeps
 * every dashboard data-lib consistent: none of them import a live pipeline
 * package, they only ever read a plain artifact off disk.
 *
 * This is the "unknown/failed things must surface, never look healthy"
 * page (see lib/health.ts's house philosophy) for scheduled jobs: a job
 * whose lastStatus is "error" must render with a clear, unmissable ERROR
 * badge and its real error message -- never hidden, never downgraded to
 * looking like a healthy "ok" or a neutral "never-run".
 */
import path from "node:path";
import os from "node:os";
import { readFileSync, readdirSync } from "node:fs";

export interface JobStatusRecord {
  name: string;
  lastRunAt?: string;
  lastStatus: "ok" | "error" | "never-run";
  lastError?: string;
  lastSummary?: Record<string, unknown>;
  lastDurationMs?: number;
  nextDueAt?: string;
}

/**
 * Env var first, falling back to `<HOME>/.pros/schedule` -- following the
 * `os.homedir()` convention lib/loops-data.ts uses for a package with no
 * prior CLI convention to match byte-for-byte (unlike lib/config.ts, which
 * intentionally matches the CLI's `HOME ?? "/root"` convention -- see that
 * file's doc comment. @pros/schedule/CLI's own default IS `HOME ?? "/root"`,
 * but this dashboard module's own convention here mirrors loops-data.ts for
 * consistency across this M7 addition; see this file's own doc comment for
 * the explicit choice).
 */
export function getScheduleStatusDir(): string {
  return process.env.PROS_SCHEDULE_STATUS_DIR ?? path.join(os.homedir(), ".pros", "schedule");
}

function coerceJobStatus(value: unknown): JobStatusRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return undefined;
  if (v.lastStatus !== "ok" && v.lastStatus !== "error" && v.lastStatus !== "never-run") return undefined;

  const record: JobStatusRecord = { name: v.name, lastStatus: v.lastStatus };
  if (typeof v.lastRunAt === "string") record.lastRunAt = v.lastRunAt;
  if (typeof v.lastError === "string") record.lastError = v.lastError;
  if (typeof v.nextDueAt === "string") record.nextDueAt = v.nextDueAt;
  if (typeof v.lastDurationMs === "number") record.lastDurationMs = v.lastDurationMs;
  if (typeof v.lastSummary === "object" && v.lastSummary !== null) {
    record.lastSummary = v.lastSummary as Record<string, unknown>;
  }
  return record;
}

/**
 * Reads a single `${statusDir}/<jobName>.json` file. Never throws:
 * missing file, unparseable JSON, or wrong shape all resolve to
 * `undefined`, mirroring this project's tolerant-parsing house style.
 */
function readOneJobStatus(statusDir: string, fileName: string): JobStatusRecord | undefined {
  const filePath = path.join(statusDir, fileName);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return coerceJobStatus(parsed);
}

/**
 * Reads every `*.json` file in `statusDir` and returns the valid,
 * well-shaped job statuses. Never throws: a missing statusDir, an
 * unreadable directory, or individual malformed files all degrade
 * gracefully (missing dir -> [], malformed file -> dropped, not fatal).
 */
export function listScheduleStatuses(statusDir: string): JobStatusRecord[] {
  let names: string[];
  try {
    names = readdirSync(statusDir);
  } catch {
    return [];
  }
  const jsonNames = names.filter((n) => n.endsWith(".json") && !n.startsWith("."));
  const statuses: JobStatusRecord[] = [];
  for (const name of jsonNames) {
    const status = readOneJobStatus(statusDir, name);
    if (status) statuses.push(status);
  }
  // Stable, deterministic ordering for rendering.
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  return statuses;
}
