/**
 * Ties the trigger sources, dedup store, and concurrency lease together into
 * one sweep cycle (M7).
 *
 * Per-signal flow, in order (see dedup.ts's doc comment for why this exact
 * ordering matters):
 *   1. peek `hasClaimed` -- if already claimed, it's a duplicate, skip.
 *   2. if not claimed, try `ConcurrencyLease.acquire()` for the signal's
 *      deterministic runId.
 *      - `LeaseUnavailableError` -> record as deferred, do NOT claim. A
 *        later cycle with lease headroom can still pick this signal up.
 *      - acquired -> durably `claim()`, then call `onNewSignal`, then
 *        ALWAYS `lease.release()` in a finally (even if onNewSignal
 *        throws), so a slot is never held longer than the admission call.
 *
 * Isolation: one failing source must never prevent other sources' signals
 * from being processed, and must never throw out of `runTriggerCycle`. Same
 * discipline per-signal: one signal's admission failure must not lose the
 * rest of that source's (or another source's) signals.
 */

import { ConcurrencyLease, LeaseUnavailableError } from "@pros/lease";
import { SignalDedupStore, signalDedupId } from "./dedup.js";
import type { Signal, TriggerSource } from "./types.js";

export interface SourceFailure {
  sourceId: string;
  error: string;
}

export interface AdmissionFailure {
  sourceId: string;
  externalId: string;
  error: string;
}

export interface AdmissionContext {
  leaseDir: string;
  maxConcurrent: number;
}

export interface TriggerCycleResult {
  admittedRunIds: string[];
  /** Signals that were new but the lease was unavailable -- will retry next cycle. */
  skippedDeferred: string[];
  duplicatesSuppressed: number;
  sourceFailures: SourceFailure[];
  /** A signal was claimed/leased but onNewSignal itself threw. */
  admissionFailures: AdmissionFailure[];
}

export interface RunTriggerCycleOptions {
  sources: TriggerSource[];
  dedupDir: string;
  leaseDir: string;
  maxConcurrent: number;
  onNewSignal: (signal: Signal, ctx: { runId: string }) => Promise<void>;
}

export async function runTriggerCycle(opts: RunTriggerCycleOptions): Promise<TriggerCycleResult> {
  const result: TriggerCycleResult = {
    admittedRunIds: [],
    skippedDeferred: [],
    duplicatesSuppressed: 0,
    sourceFailures: [],
    admissionFailures: [],
  };

  for (const source of opts.sources) {
    let signals: Signal[];
    try {
      signals = await source.fetchSignals();
    } catch (err: any) {
      result.sourceFailures.push({ sourceId: source.id, error: err?.message ?? String(err) });
      continue;
    }

    for (const signal of signals) {
      await admitOneSignal(signal, opts, result);
    }
  }

  return result;
}

async function admitOneSignal(
  signal: Signal,
  opts: RunTriggerCycleOptions,
  result: TriggerCycleResult,
): Promise<void> {
  const runId = signalDedupId(signal);

  let alreadyClaimed: boolean;
  try {
    alreadyClaimed = await SignalDedupStore.hasClaimed(opts.dedupDir, signal);
  } catch (err: any) {
    result.admissionFailures.push({ sourceId: signal.sourceId, externalId: signal.externalId, error: err?.message ?? String(err) });
    return;
  }
  if (alreadyClaimed) {
    result.duplicatesSuppressed++;
    return;
  }

  let lease;
  try {
    lease = await ConcurrencyLease.acquire({ leaseDir: opts.leaseDir, maxConcurrent: opts.maxConcurrent, runId });
  } catch (err) {
    if (err instanceof LeaseUnavailableError) {
      result.skippedDeferred.push(runId);
      return;
    }
    result.admissionFailures.push({ sourceId: signal.sourceId, externalId: signal.externalId, error: (err as any)?.message ?? String(err) });
    return;
  }

  try {
    await SignalDedupStore.claim(opts.dedupDir, signal);
    await opts.onNewSignal(signal, { runId });
    result.admittedRunIds.push(runId);
  } catch (err: any) {
    result.admissionFailures.push({ sourceId: signal.sourceId, externalId: signal.externalId, error: err?.message ?? String(err) });
  } finally {
    await lease.release();
  }
}
