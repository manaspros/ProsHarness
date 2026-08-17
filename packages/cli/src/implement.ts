/**
 * `pros implement <run-id>` -- the missing CLI entry point for Gate 2
 * (docs/11-project-status.md known-gap #1). `runGate2Pipeline` (@pros/
 * implement) has been fully built and tested since M4 but, until now, was
 * only ever invoked directly from test files.
 *
 * Mirrors reconcile.ts/plan.ts/answer.ts/schedule.ts's established
 * env-var-driven config resolution: `<HOME ?? "/root">/.pros/<name>`
 * fallback convention, same env var names as `pros schedule`'s
 * `buildScheduledJobs`.
 */
import path from "node:path";
import { loadRunState } from "@pros/barrier";
import { TokenCeiling } from "@pros/lease";
import { deriveGate2OptionsFromRun, isGate2AlreadyStarted, runGate2Pipeline } from "@pros/implement";
import { recordGate2Operation } from "./gate2-operation.js";

export interface ImplementArgs {
  runId: string;
  runsRoot: string;
  repoRoot: string;
  leaseDir: string;
  maxConcurrent: number;
  maxTokensPerRun: number;
  ntfyUrl?: string;
}

export function parseImplementArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ImplementArgs {
  // pros implement <run-id>
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [runId] = positional;
  if (!runId) {
    throw new Error("usage: pros implement <run-id>");
  }
  const home = env.HOME ?? "/root";
  return {
    runId,
    runsRoot: env.PROS_RUNS_DIR ?? path.join(home, ".pros", "runs"),
    repoRoot: env.PROS_REPO_ROOT ?? process.cwd(),
    leaseDir: env.PROS_LEASE_DIR ?? path.join(home, ".pros", "leases"),
    maxConcurrent: env.PROS_MAX_CONCURRENT ? Number(env.PROS_MAX_CONCURRENT) : 3,
    maxTokensPerRun: env.PROS_MAX_TOKENS_PER_RUN ? Number(env.PROS_MAX_TOKENS_PER_RUN) : 200_000,
    ntfyUrl: env.PROS_NTFY_URL,
  };
}

/**
 * Verifies Gate 1 was actually approved (not amended/aborted/never
 * answered) for this run, and that Gate 2 hasn't already been started, then
 * runs Gate 2 to completion (or its abort stage). Throws a clear error for
 * every "not ready"/"already done" condition rather than silently
 * proceeding or silently no-oping.
 */
export async function runImplementCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  opts: { notificationsEnabled?: boolean } = {},
): Promise<string> {
  const args = parseImplementArgs(argv, env);
  const runDir = path.join(args.runsRoot, args.runId);

  const state = await loadRunState(runDir);
  const gate1Checkpoint = [...state.checkpoints.values()].find((cp) => cp.gateType === "plan_approval");
  if (!gate1Checkpoint) {
    throw new Error(`pros implement: no Gate 1 (plan_approval) checkpoint found for run ${args.runId} under ${runDir}`);
  }
  if (gate1Checkpoint.phase !== "answered") {
    throw new Error(
      `pros implement: Gate 1 checkpoint for run ${args.runId} is not yet answered (phase=${gate1Checkpoint.phase}) -- approve it first via \`pros answer\``,
    );
  }
  if (gate1Checkpoint.effect !== "continue_within_approved_plan") {
    throw new Error(
      `pros implement: Gate 1 checkpoint for run ${args.runId} was answered with effect="${gate1Checkpoint.effect}", not "continue_within_approved_plan" -- refusing to run Gate 2 on an unapproved/amended/aborted plan`,
    );
  }

  if (await isGate2AlreadyStarted(runDir)) {
    throw new Error(`pros implement: Gate 2 has already been started or completed for run ${args.runId} -- refusing to double-run`);
  }

  await recordGate2Operation({ runId: args.runId, runDir, requestedBy: "cli", transition: "started" });
  let result;
  try {
    const derived = await deriveGate2OptionsFromRun({
      runsRoot: args.runsRoot,
      runId: args.runId,
      repoRoot: args.repoRoot,
      leaseDir: args.leaseDir,
      maxConcurrent: args.maxConcurrent,
      tokenCeiling: new TokenCeiling({ maxTotalTokens: args.maxTokensPerRun }),
      ntfyUrl: args.ntfyUrl,
    });

    result = await runGate2Pipeline({ ...derived, reapWorktreeOnSuccess: true, notificationsEnabled: opts.notificationsEnabled ?? false });
    await recordGate2Operation({ runId: args.runId, runDir, requestedBy: "cli", transition: "completed", result });
  } catch (err) {
    await recordGate2Operation({
      runId: args.runId,
      runDir,
      requestedBy: "cli",
      transition: "failed",
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    throw err;
  }

  if (result.pr) {
    return `pros implement ${args.runId}: draft PR opened at ${result.pr.url} (verify=${result.verdict.outcome}, review=${result.review.verdict})`;
  }
  return `pros implement ${args.runId}: stopped at stage "${result.aborted?.stage}" -- ${result.aborted?.reason ?? "unknown reason"}`;
}
