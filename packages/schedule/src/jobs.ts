/**
 * The two real scheduled jobs, wired to the packages built for M7:
 * `@pros/triggers`'s `runTriggerCycle`/`createRealOnNewSignal`, and
 * `@pros/skillrank`'s `runSkillrank`/`writeSkillrankOutput`.
 *
 * Both `run()` functions let genuine errors propagate -- neither catches
 * anything itself. `runJobOnce` (run-job.ts) is the single place
 * responsible for catching and recording failures; duplicating that here
 * would just hide the real error message behind a second layer.
 */

import { runTriggerCycle, createRealOnNewSignal } from "@pros/triggers";
import type { TriggerSource } from "@pros/triggers";
import { runSkillrank, writeSkillrankOutput } from "@pros/skillrank";
import type { JobRunSummary, ScheduledJob } from "./types.js";

const DEFAULT_TRIGGER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SKILLRANK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
