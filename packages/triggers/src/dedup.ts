/**
 * The signal dedup store (M7).
 *
 * Same durability discipline as `@pros/lease`'s `ConcurrencyLease`
 * (packages/lease/src/concurrency-lease.ts): a `mkdir`-as-mutex around the
 * dedup dir for the check-and-claim critical section, one small JSON file
 * per claimed signal, atomic temp-write + fsync(file) + rename + fsync(dir).
 *
 * The claim filename is `sha256(sourceId + ":" + externalId)` -- stable,
 * filesystem-safe, and (critically) the SAME hash is reused as the
 * `runId` returned from a claim. That means re-claiming the same signal
 * always yields the same runId, which is what makes retries idempotent one
 * layer up: `runPlanPipeline`'s own `parkForGate1` idempotencyKey pattern
 * (packages/plan/src/pipeline.ts) means a crash-and-retry of admission for
 * the same signal can never mint two Gate 1 checkpoints, because it's the
 * same runId both times.
 *
 * Ordering subtlety (see runner.ts): claiming must happen ONLY after the
 * concurrency lease was actually acquired for this signal's runId. If the
 * lease is unavailable this cycle, the signal must NOT be marked claimed,
 * so a later sweep with lease headroom can still pick it up. This module
 * exposes that as two separate operations rather than one atomic
 * "claim-or-fail": `hasClaimed` (cheap peek, no lock) for the runner to
 * decide whether to even attempt lease acquisition, and `claim` (durable,
 * lock-protected) that the runner calls only after a successful lease
 * acquire. `claim` is itself idempotent/safe to call more than once for the
 * same signal -- it just writes the same content to the same path again.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rename, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Signal } from "./types.js";

const LOCK_RETRY_MS = 20;
const LOCK_MAX_ATTEMPTS = 200; // ~4s worst case

export interface ClaimResult {
  isNew: boolean;
  runId: string;
}

export interface ClaimRecord {
  runId: string;
  sourceId: string;
  externalId: string;
  claimedAt: string;
}

/** Deterministic dedup key AND deterministic runId -- see module doc comment for why these are the same hash. */
export function signalDedupId(signal: Signal): string {
  return createHash("sha256").update(`${signal.sourceId}:${signal.externalId}`).digest("hex");
}

function claimFilePath(dedupDir: string, dedupId: string): string {
  return path.join(dedupDir, `${dedupId}.json`);
}

function lockDirPath(dedupDir: string): string {
  return path.join(dedupDir, ".lock");
}

async function fsyncDir(dirPath: string): Promise<void> {
  const dh = await open(dirPath, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

async function withDedupDirLock<T>(dedupDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockDirPath(dedupDir);
  let attempts = 0;
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false });
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      attempts++;
      if (attempts >= LOCK_MAX_ATTEMPTS) {
        throw new Error(`dedup lock at ${lockPath} held too long -- possible stuck claim()`);
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

async function writeClaimRecord(dedupDir: string, record: ClaimRecord): Promise<void> {
  const finalPath = claimFilePath(dedupDir, record.runId);
  const tmpPath = path.join(
    dedupDir,
    `.${record.runId}.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(JSON.stringify(record, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, finalPath);
  await fsyncDir(dedupDir);
}

export class SignalDedupStore {
  /** Cheap peek: has this signal already been durably claimed? No locking needed -- a claim file's presence is the only thing this checks, and a concurrent claim() mid-peek just means the peek can race a fresh claim (acceptable: the runner only uses this to decide whether lease acquisition is worth attempting, never as the sole guard against a double-admit -- `claim` is idempotent and safe to call redundantly). */
  static async hasClaimed(dedupDir: string, signal: Signal): Promise<boolean> {
    const dedupId = signalDedupId(signal);
    try {
      await stat(claimFilePath(dedupDir, dedupId));
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Durably claim a signal. Returns `isNew: true` + the deterministic runId
   * the FIRST time a signal is claimed, and `isNew: false` (same runId) on
   * every subsequent claim of the same signal -- whether from the same
   * cycle or a later one. Safe to call concurrently: the mkdir-lock makes
   * the check-and-write atomic across processes.
   */
  static async claim(dedupDir: string, signal: Signal): Promise<ClaimResult> {
    await mkdir(dedupDir, { recursive: true });
    const dedupId = signalDedupId(signal);

    return withDedupDirLock(dedupDir, async () => {
      const filePath = claimFilePath(dedupDir, dedupId);
      let alreadyClaimed = false;
      try {
        await stat(filePath);
        alreadyClaimed = true;
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }

      if (alreadyClaimed) {
        return { isNew: false, runId: dedupId };
      }

      await writeClaimRecord(dedupDir, {
        runId: dedupId,
        sourceId: signal.sourceId,
        externalId: signal.externalId,
        claimedAt: new Date().toISOString(),
      });
      return { isNew: true, runId: dedupId };
    });
  }
}

/** Exported for tests wanting to assert on file presence without duplicating path logic. */
export function claimPathFor(dedupDir: string, signal: Signal): string {
  return claimFilePath(dedupDir, signalDedupId(signal));
}

// Re-export a read helper for tests/debugging that want the raw record.
export async function readClaimRecord(dedupDir: string, signal: Signal): Promise<ClaimRecord | undefined> {
  try {
    const raw = await readFile(claimFilePath(dedupDir, signalDedupId(signal)), "utf8");
    return JSON.parse(raw) as ClaimRecord;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}
