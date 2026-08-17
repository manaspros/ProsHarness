/**
 * The scheduled jobs wired to the packages built for M7 and the Gate 1 ->
 * Gate 2 continuation gap closed afterward:
 * `@pros/triggers`'s `runTriggerCycle`/`createRealOnNewSignal`,
 * `@pros/skillrank`'s `runSkillrank`/`writeSkillrankOutput`, and
 * `@pros/implement`'s `deriveGate2OptionsFromRun`/`runGate2Pipeline` (the
 * Gate 1 continuation job, `makeGate1ContinuationJob`).
 *
 * `makeTriggerSweepJob`/`makeSkillrankWeeklyJob`'s `run()` functions let
 * genuine errors propagate -- neither catches anything itself. `runJobOnce`
 * (run-job.ts) is the single place responsible for catching and recording
 * failures; duplicating that here would just hide the real error message
 * behind a second layer.
 *
 * `makeGate1ContinuationJob` is a deliberate exception to that rule: it
 * iterates MANY candidate runs per tick, and one candidate's failure (a
 * busy concurrency lease, a transient `gh`/git error, a genuinely broken
 * run) must not prevent the other candidates in the same tick from being
 * tried -- so failures are caught PER CANDIDATE and counted in the returned
 * summary, while the job's `run()` itself still throws after the scan when
 * one or more candidates failed. That final rejection is important: a
 * resolved summary with `failures > 0` would otherwise be recorded as an
 * overall scheduler success by `runJobOnce`.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { TokenCeiling } from "@pros/lease";
import { deriveGate2OptionsFromRun, isGate2AlreadyStarted, runGate2Pipeline } from "@pros/implement";
import { runTriggerCycle, createRealOnNewSignal } from "@pros/triggers";
import type { TriggerSource } from "@pros/triggers";
import { runSkillrank, writeSkillrankOutput } from "@pros/skillrank";
import { ScheduledJobError } from "./types.js";
import type { JobRunSummary, ScheduledJob } from "./types.js";
import { recordGate2Operation } from "./gate2-operation.js";

const DEFAULT_TRIGGER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SKILLRANK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/**
 * An approved plan sitting around waiting for someone to notice is exactly
 * the UX gap this job closes (docs/11-project-status.md known-gap #1), so
 * this polls much more often than the trigger sweep (5 min) or skillrank
 * (weekly) -- 2 minutes is frequent enough that "approve on your phone,
 * Gate 2 starts within a couple minutes" feels immediate, without hammering
 * `runsRoot`'s directory scan (cheap: a `readdir` + a journal read per run,
 * same cost shape as `reconcilePrOps`, which already runs this same scan
 * pattern on-demand via `pros reconcile`).
 */
const DEFAULT_GATE1_CONTINUATION_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export interface TriggerSweepJobOptions {
  sources: TriggerSource[];
  dedupDir: string;
  leaseDir: string;
  maxConcurrent: number;
  repoRoot: string;
  worktreesRoot: string;
  runsRoot: string;
  maxTokensPerRun: number;
  ntfyUrl?: string;
  intervalMs?: number;
}

export function makeTriggerSweepJob(opts: TriggerSweepJobOptions): ScheduledJob {
  return {
    name: "trigger-sweep",
    intervalMs: opts.intervalMs ?? DEFAULT_TRIGGER_SWEEP_INTERVAL_MS,
    async run(): Promise<JobRunSummary> {
      const result = await runTriggerCycle({
        sources: opts.sources,
        dedupDir: opts.dedupDir,
        leaseDir: opts.leaseDir,
        maxConcurrent: opts.maxConcurrent,
        onNewSignal: createRealOnNewSignal({
          repoRoot: opts.repoRoot,
          worktreesRoot: opts.worktreesRoot,
          runsRoot: opts.runsRoot,
          maxTokensPerRun: opts.maxTokensPerRun,
          ntfyUrl: opts.ntfyUrl,
        }),
      });

      return {
        admitted: result.admittedRunIds.length,
        deferred: result.skippedDeferred.length,
        duplicates: result.duplicatesSuppressed,
        sourceFailures: result.sourceFailures.length,
        sourceFailureIds: result.sourceFailures.map((f) => f.sourceId),
        admissionFailures: result.admissionFailures.length,
      };
    },
  };
}

export interface SkillrankWeeklyJobOptions {
  lockFilePath: string;
  minerOutDir: string;
  outDir: string;
  intervalMs?: number;
}

export function makeSkillrankWeeklyJob(opts: SkillrankWeeklyJobOptions): ScheduledJob {
  return {
    name: "skillrank-weekly",
    intervalMs: opts.intervalMs ?? DEFAULT_SKILLRANK_INTERVAL_MS,
    async run(): Promise<JobRunSummary> {
      const result = runSkillrank({
        lockFilePath: opts.lockFilePath,
        minerOutDir: opts.minerOutDir,
        outDir: opts.outDir,
      });
      writeSkillrankOutput(result, opts.outDir);

      return {
        proposalCount: result.proposals.length,
        installedCount: result.installedSlugs.length,
      };
    },
  };
}

export interface Gate1ContinuationJobOptions {
  runsRoot: string;
  /** ProsHarness's own installation root, threaded through to `deriveGate2OptionsFromRun` -- NOT the target/originating repo. */
  repoRoot: string;
  /** Same lease dir/maxConcurrent the ambient trigger sweep uses (docs/00-decisions.md D21) -- one global concurrency budget, not a second mechanism. */
  leaseDir: string;
  maxConcurrent: number;
  maxTokensPerRun: number;
  ntfyUrl?: string;
  intervalMs?: number;
  /**
   * Test-only seam: fields merged onto every candidate's derived
   * `Gate2PipelineOptions` before `runGate2Pipeline` is called (e.g. fake
   * `claudeSession`/`codexSession`/`verifierSession`/`ghClient`/`ghCredential`,
   * mirroring `test/e2e-m4.test.ts`'s `Gate2ClaudeSession`/`LocalGhStub`).
   * Never set outside tests -- real scheduled runs rely on
   * `runGate2Pipeline`'s own real-session/real-`gh` defaults.
   */
  gate2OptionsOverride?: Partial<Parameters<typeof runGate2Pipeline>[0]>;
}

/**
 * Closes the Gate 1 -> Gate 2 continuation gap: scans `runsRoot` (same
 * `readdir` + `Journal.exists` pattern `reconcilePrOps` uses) for runs with
 * an ANSWERED `plan_approval` checkpoint whose recorded effect is
 * `continue_within_approved_plan`, and runs Gate 2 for each one that
 * hasn't already been continued.
 *
 * Idempotent/safely re-runnable across ticks via `isGate2AlreadyStarted`
 * (shared with `pros implement`'s own guard, packages/implement/src/
 * from-run.ts) -- a run already picked up by a previous tick, or manually
 * via `pros implement`, is skipped rather than double-run.
 *
 * Stale/superseded-approval guard: a checkpoint's OWN recorded fenceEpoch
 * (captured on its `checkpoint_requested` journal entry, at park time) is
 * compared against the run's CURRENT fenceEpoch (`loadRunState(runDir).fenceEpoch`).
 * `Barrier.recordAnswer` only bumps the fence epoch for
 * `effect === "requires_plan_amendment" | "abort"` -- so an approval whose
 * checkpoint fenceEpoch no longer matches the run's current epoch means
 * SOME other answer (a race between two concurrent `pros answer` /
 * dashboard calls both observing the checkpoint as still "parked" before
 * either one's answer landed -- see run-state.ts's "answered" projection
 * comment: "first conditional update wins; later concurrent answers are
 * audit-only") bumped the fence after this approval was recorded. That is
 * exactly the stale/replayed/raced case this guard exists to catch, and
 * continuation is skipped for it.
 */
export function makeGate1ContinuationJob(opts: Gate1ContinuationJobOptions): ScheduledJob {
  return {
    name: "gate1-continuation",
    intervalMs: opts.intervalMs ?? DEFAULT_GATE1_CONTINUATION_INTERVAL_MS,
    async run(): Promise<JobRunSummary> {
      let continued = 0;
      let skippedStale = 0;
      let skippedAlreadyStarted = 0;
      let failures = 0;
      const failureRunIds: string[] = [];
      const failureMessages: string[] = [];

      let runIds: string[];
      try {
        runIds = (await readdir(opts.runsRoot, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          runIds = [];
        } else {
          throw err;
        }
      }

      for (const runId of runIds) {
        const runDir = path.join(opts.runsRoot, runId);
        if (!(await Journal.exists(runDir))) continue;

        const state = await loadRunState(runDir);
        const gate1Checkpoint = [...state.checkpoints.values()].find(
          (cp) => cp.gateType === "plan_approval" && cp.phase === "answered" && cp.effect === "continue_within_approved_plan",
        );
        if (!gate1Checkpoint) continue;

        if (await isGate2AlreadyStarted(runDir)) {
          skippedAlreadyStarted++;
          continue;
        }

        const { entries } = await Journal.read(runDir);
        const requestedEntry = entries.find(
          (e) => e.kind === "checkpoint_requested" && (e as { checkpointId: string }).checkpointId === gate1Checkpoint.checkpointId,
        );
        if (!requestedEntry || requestedEntry.fenceEpoch !== state.fenceEpoch) {
          skippedStale++;
          continue;
        }

        try {
          await recordGate2Operation({ runId, runDir, requestedBy: "scheduler", transition: "started" });
          const derived = await deriveGate2OptionsFromRun({
            runsRoot: opts.runsRoot,
            runId,
            repoRoot: opts.repoRoot,
            leaseDir: opts.leaseDir,
            maxConcurrent: opts.maxConcurrent,
            tokenCeiling: new TokenCeiling({ maxTotalTokens: opts.maxTokensPerRun }),
            ntfyUrl: opts.ntfyUrl,
          });
          const result = await runGate2Pipeline({ ...derived, reapWorktreeOnSuccess: true, ...opts.gate2OptionsOverride });
          await recordGate2Operation({ runId, runDir, requestedBy: "scheduler", transition: "completed", result });
          continued++;
        } catch (err: unknown) {
          // Per-candidate catch -- see file doc comment. A busy
          // ConcurrencyLease throws immediately rather than waiting
          // (@pros/lease's documented admission-control semantics), so a
          // fully-booked lease surfaces here as a normal per-candidate
          // failure, not a crashed job.
          failures++;
          failureRunIds.push(runId);
          const message = err instanceof Error ? err.message : String(err);
          failureMessages.push(`${runId}: ${message}`);
          await recordGate2Operation({ runId, runDir, requestedBy: "scheduler", transition: "failed", error: message }).catch(() => undefined);
        }
      }

      const summary = { continued, skippedStale, skippedAlreadyStarted, failures, failureRunIds };
      if (failures > 0) {
        throw new ScheduledJobError(`gate1 continuation failed for run(s): ${failureMessages.join("; ")}`, summary);
      }
      return summary;
    },
  };
}
