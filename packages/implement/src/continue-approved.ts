import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { TokenCeiling } from "@pros/lease";
import { notificationsEnabledFromEnv } from "@pros/notify";
import { deriveGate2OptionsFromRun, isGate2AlreadyStarted } from "./from-run.js";
import { runGate2Pipeline, type Gate2PipelineOptions, type Gate2PipelineResult } from "./pipeline.js";

export interface ContinueApprovedGate2Options {
  runsRoot: string;
  runId: string;
  /** ProsHarness installation root used to load the implementer agent brief. */
  repoRoot: string;
  leaseDir?: string;
  maxConcurrent?: number;
  maxTokensPerRun: number;
  ntfyUrl?: string;
  /**
   * Explicit entry-point policy for the fresh Gate 2 run. Undefined (not
   * `false`) defers to `PROS_NOTIFICATIONS_ENABLED` via
   * `notificationsEnabledFromEnv` -- B8: this used to hardcode `?? false`,
   * silencing the gate even when the operator set the flag. A caller that
   * wants notifications OFF regardless of the env var (e.g. the dashboard's
   * "Approve" button, which is deliberately silent -- see
   * app/api/runs/[runId]/checkpoints/[checkpointId]/answer/route.ts) must
   * still pass `notificationsEnabled: false` explicitly; that override is
   * preserved.
   */
  notificationsEnabled?: boolean;
  /** Defaults to process.env; injectable for tests so no test depends on real ambient env vars. */
  env?: NodeJS.ProcessEnv;
  /** Test seam and explicit policy overrides for the fresh Gate 2 context. */
  gate2OptionsOverride?: Partial<Gate2PipelineOptions>;
}

/**
 * Run Gate 2 immediately for an approved Gate 1 checkpoint.
 *
 * This is shared by the dashboard's Approve action and the CLI/scheduler
 * paths. It repeats the durable approval and fence checks at the point of
 * execution, so a redirect, retry, or competing scheduler cannot turn a
 * stale approval into an implementation run.
 */
export async function runApprovedGate2(opts: ContinueApprovedGate2Options): Promise<Gate2PipelineResult> {
  const runDir = path.join(opts.runsRoot, opts.runId);
  const state = await loadRunState(runDir);
  const checkpoint = [...state.checkpoints.values()].find((cp) => cp.gateType === "plan_approval");
  if (!checkpoint) {
    throw new Error(`runApprovedGate2: no Gate 1 checkpoint found for run ${opts.runId}`);
  }
  if (checkpoint.phase !== "answered" || checkpoint.effect !== "continue_within_approved_plan") {
    throw new Error(
      `runApprovedGate2: Gate 1 for run ${opts.runId} is not an approved, answered checkpoint (phase=${checkpoint.phase}, effect=${checkpoint.effect ?? "none"})`,
    );
  }

  const { entries } = await Journal.read(runDir);
  const requested = entries.find(
    (entry) => entry.kind === "checkpoint_requested" && entry.checkpointId === checkpoint.checkpointId,
  );
  if (!requested || requested.fenceEpoch !== state.fenceEpoch) {
    throw new Error(`runApprovedGate2: Gate 1 approval for run ${opts.runId} is stale`);
  }
  if (await isGate2AlreadyStarted(runDir)) {
    throw new Error(`runApprovedGate2: Gate 2 has already started or completed for run ${opts.runId}`);
  }

  const derived = await deriveGate2OptionsFromRun({
    runsRoot: opts.runsRoot,
    runId: opts.runId,
    repoRoot: opts.repoRoot,
    leaseDir: opts.leaseDir,
    maxConcurrent: opts.maxConcurrent,
    tokenCeiling: new TokenCeiling({ maxTotalTokens: opts.maxTokensPerRun }),
    ntfyUrl: opts.ntfyUrl,
  });

  // No session from Gate 1 is passed here. Gate 2 intentionally starts with
  // fresh model context; only the approved plan and durable run records carry
  // the hand-off.
  return runGate2Pipeline({
    ...derived,
    reapWorktreeOnSuccess: true,
    notificationsEnabled: opts.notificationsEnabled ?? notificationsEnabledFromEnv(opts.env),
    ...opts.gate2OptionsOverride,
  });
}
