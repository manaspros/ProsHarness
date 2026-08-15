/**
 * The global concurrency lease (M4, docs/00-decisions.md D21).
 *
 * Model routing lowers *average* burn but is not capacity control: several
 * scheduled runs can each independently pass admission against the same
 * stale rate_limit_event and collectively exhaust the pool. This lease is
 * the fix -- a durable, filesystem-backed count of how many unattended runs
 * are doing implementation work RIGHT NOW, system-wide (not per-repo), so a
 * newly-starting run can refuse to start rather than pile on.
 *
 * `acquire()` is admission control, not a blocking wait: per D21, interactive
 * runs are never blocked by this at all (they don't call it), and unattended
 * runs that can't get a slot fail fast with `LeaseUnavailableError` so the
 * caller (the scheduler) can decide to retry later, queue, or give up -- this
 * package has no opinion on that policy.
 *
 * Durability follows the same house pattern as `@pros/worktree`'s
 * `writeActiveWorktreeRecord` and `@pros/barrier`'s `Journal`: every lease
 * file is a small JSON blob written via temp-file + fsync(file) + rename +
 * fsync(dir), so a lease is either fully there or not there at all, even
 * across a crash mid-write. There is no journal here (leases are pure
 * current-state, not a history that needs replay) -- just one file per
 * live lease, named by runId, that a crash leaves behind as a stale
 * heartbeat for `reconcileStale()`/`listActive()` to find and clean up.
 *
 * Cross-process mutual exclusion for the "list + count + decide + write"
 * critical section in `acquire()` uses the same `mkdir`-as-mutex trick as
 * `@pros/barrier`'s journal lock (`mkdir` is atomic and fails with EEXIST
 * if another acquire() is already inside the section) -- this is the same
 * "one guardian survives" race the barrier's kill-test #11 covers, just for
 * a simpler critical section (no journal to append to, just a directory
 * listing and one atomic file write).
 *
 * Heartbeats are NOT driven by a timer owned by this class -- mirroring how
 * `@pros/barrier`'s `Guardian`/`Barrier` explicitly document who owns
 * timers, `ConcurrencyLease.heartbeat()` is a plain one-shot data operation.
 * The caller (whatever drives the run loop) is responsible for calling it
 * periodically, e.g. via its own `setInterval`, for the life of the run.
 * Keeping timers out of this class means it has no background state to leak
 * across tests.
 */

import { mkdir, open, rename, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STALE_AFTER_MS = 60_000;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_ATTEMPTS = 200; // ~4s worst case

export interface LeaseRecord {
  runId: string;
  acquiredAt: string;
  heartbeatAt: string;
  pid: number;
}

export interface ActiveLeaseInfo extends LeaseRecord {
  stale: boolean;
}

export class LeaseUnavailableError extends Error {
  constructor(
    public readonly held: number,
    public readonly max: number,
  ) {
    super(`concurrency lease unavailable: ${held}/${max} slots already held`);
    this.name = "LeaseUnavailableError";
  }
}

export interface AcquireOptions {
  leaseDir: string;
  maxConcurrent: number;
  runId: string;
  /** A lease is considered dead (not counted, best-effort removed) once its heartbeatAt is older than this. Default 60_000ms. */
  staleAfterMs?: number;
}

function leaseFilePath(leaseDir: string, runId: string): string {
  return path.join(leaseDir, `${runId}.json`);
}

function lockDirPath(leaseDir: string): string {
  return path.join(leaseDir, ".lock");
}

async function fsyncDir(dirPath: string): Promise<void> {
  const dh = await open(dirPath, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/** Atomic temp-write + fsync(file) + rename + fsync(dir), same pattern as worktree's writeActiveWorktreeRecord. */
async function writeLeaseRecord(leaseDir: string, record: LeaseRecord): Promise<void> {
  const finalPath = leaseFilePath(leaseDir, record.runId);
  const tmpPath = path.join(leaseDir, `.${record.runId}.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(JSON.stringify(record, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, finalPath);
  await fsyncDir(leaseDir);
}

async function readLeaseFile(filePath: string): Promise<LeaseRecord | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as LeaseRecord;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    // Corrupt/partial lease file (e.g. crash mid non-atomic write from some
    // other tool) -- treat it as absent rather than blowing up admission.
    return undefined;
  }
}

function isStale(record: LeaseRecord, staleAfterMs: number, now: number = Date.now()): boolean {
  const heartbeatMs = Date.parse(record.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return true;
  return now - heartbeatMs > staleAfterMs;
}

async function listLeaseFiles(leaseDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(leaseDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n.endsWith(".json") && !n.startsWith("."));
}

/** mkdir-based cross-process mutex around the leaseDir, same trick as barrier's journal lock. */
async function withLeaseDirLock<T>(leaseDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockDirPath(leaseDir);
  let attempts = 0;
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false });
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      attempts++;
      if (attempts >= LOCK_MAX_ATTEMPTS) {
        throw new Error(`lease lock at ${lockPath} held too long -- possible stuck acquire()`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class ConcurrencyLease {
  private constructor(
    private readonly leaseDir: string,
    private readonly runId: string,
    private readonly staleAfterMs: number,
  ) {}

  static async acquire(opts: AcquireOptions): Promise<ConcurrencyLease> {
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    await mkdir(opts.leaseDir, { recursive: true });

    return withLeaseDirLock(opts.leaseDir, async () => {
      const names = await listLeaseFiles(opts.leaseDir);
      const now = Date.now();

      let liveCount = 0;
      let selfIsLive = false;
      for (const name of names) {
        const filePath = path.join(opts.leaseDir, name);
        const record = await readLeaseFile(filePath);
        if (!record) continue;

        if (isStale(record, staleAfterMs, now)) {
          // Dead run's lease -- doesn't count, and we clean it up
          // best-effort so it stops cluttering the directory. A delete
          // failure here must never abort acquire() for a live run.
          await rm(filePath, { force: true }).catch(() => undefined);
          continue;
        }

        if (record.runId === opts.runId) {
          selfIsLive = true;
        } else {
          liveCount++;
        }
      }

      if (selfIsLive) {
        // Reentrant/idempotent: refresh our own lease rather than counting
        // ourselves twice or failing a retried call.
        await writeLeaseRecord(opts.leaseDir, {
          runId: opts.runId,
          acquiredAt: (await readLeaseFile(leaseFilePath(opts.leaseDir, opts.runId)))?.acquiredAt ?? new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          pid: process.pid,
        });
        return new ConcurrencyLease(opts.leaseDir, opts.runId, staleAfterMs);
      }

      if (liveCount >= opts.maxConcurrent) {
        throw new LeaseUnavailableError(liveCount, opts.maxConcurrent);
      }

      const nowIso = new Date().toISOString();
      await writeLeaseRecord(opts.leaseDir, {
        runId: opts.runId,
        acquiredAt: nowIso,
        heartbeatAt: nowIso,
        pid: process.pid,
      });
      return new ConcurrencyLease(opts.leaseDir, opts.runId, staleAfterMs);
    });
  }

  async heartbeat(): Promise<void> {
    const filePath = leaseFilePath(this.leaseDir, this.runId);
    const existing = await readLeaseFile(filePath);
    await writeLeaseRecord(this.leaseDir, {
      runId: this.runId,
      acquiredAt: existing?.acquiredAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      pid: process.pid,
    });
  }

  async release(): Promise<void> {
    await rm(leaseFilePath(this.leaseDir, this.runId), { force: true }).catch(() => undefined);
  }

  static async listActive(leaseDir: string, staleAfterMs: number = DEFAULT_STALE_AFTER_MS): Promise<ActiveLeaseInfo[]> {
    const names = await listLeaseFiles(leaseDir);
    const now = Date.now();
    const results: ActiveLeaseInfo[] = [];
    for (const name of names) {
      const record = await readLeaseFile(path.join(leaseDir, name));
      if (!record) continue;
      results.push({ ...record, stale: isStale(record, staleAfterMs, now) });
    }
    return results;
  }

  static async reconcileStale(leaseDir: string, staleAfterMs: number = DEFAULT_STALE_AFTER_MS): Promise<{ freed: string[] }> {
    const names = await listLeaseFiles(leaseDir);
    const now = Date.now();
    const freed: string[] = [];
    for (const name of names) {
      const filePath = path.join(leaseDir, name);
      const record = await readLeaseFile(filePath);
      if (!record) continue;
      if (isStale(record, staleAfterMs, now)) {
        await rm(filePath, { force: true }).catch(() => undefined);
        freed.push(record.runId);
      }
    }
    return { freed };
  }
}

/** Exported for tests wanting to assert on file presence without duplicating path logic. */
export function leasePathFor(leaseDir: string, runId: string): string {
  return leaseFilePath(leaseDir, runId);
}
