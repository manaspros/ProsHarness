/**
 * The real (production) `onNewSignal` admission callback (M7).
 *
 * This is the ONLY place in this package that wires up
 * `runPlanPipeline` -- `runner.ts`'s core logic takes `onNewSignal` as an
 * injectable callback precisely so tests don't need to spawn a worktree
 * allocator or real model CLIs to exercise dedup/lease/isolation behavior.
 *
 * Per docs/00-decisions.md D21, ambient trigger-admitted runs are
 * unattended, so they must acquire the SAME global concurrency lease Gate 2
 * runs use (that happens one layer up, in runner.ts, before this callback
 * is ever invoked) and must declare a per-run token ceiling. This module
 * builds that ceiling and wraps both model sessions passed into
 * `runPlanPipeline` so a run that blows its ceiling fails loudly
 * (`TokenCeilingExceededError` propagates out of `.run()`) rather than
 * silently overspending.
 */

import { TokenCeiling } from "@pros/lease";
import { RealClaudeSession, RealCodexSession, runPlanPipeline } from "@pros/plan";
import type { ModelRunOptions, ModelRunResult, ModelSession } from "@pros/plan";
import type { Signal } from "./types.js";

/** Wraps a ModelSession so every `.run()` call records its usage against `ceiling`, letting `TokenCeilingExceededError` propagate out to the caller rather than being swallowed. */
export function withTokenCeiling(session: ModelSession, ceiling: TokenCeiling): ModelSession {
  return {
    provider: session.provider,
    async run(opts: ModelRunOptions): Promise<ModelRunResult> {
      const result = await session.run(opts);
      ceiling.record(result.usage);
      return result;
    },
  };
}

/**
 * Builds the finding-session description text from a Signal. Sweep signals
 * carry known file:line evidence, so it's included explicitly -- that's
 * this source's whole value-add (see sweep.ts's doc comment): the finding
 * agent doesn't have to search for it, it already knows where to look.
 */
export function buildDescription(signal: Signal): string {
  const parts = [`[${signal.sourceId}/${signal.kind}] ${signal.title}`, "", signal.body];
  if (signal.evidence) {
    parts.push("", `Evidence: ${signal.evidence.file}:${signal.evidence.line}`);
  }
  if (signal.url) {
    parts.push("", `Source reference (read-only, do not post to): ${signal.url}`);
  }
  return parts.join("\n").trim();
}

export interface RealAdmitOptions {
  repoRoot: string;
  worktreesRoot: string;
  runsRoot: string;
  /** Fed into a fresh `TokenCeiling` for this run. */
  maxTokensPerRun: number;
  ntfyUrl?: string;
  /** Passed straight through to `runPlanPipeline({ slackTarget })` -- see that option's doc comment in @pros/plan. */
  slackTarget?: string;
  /** Explicit entry-point policy: real scheduled trigger runs opt into notifications; tests do not. */
  notificationsEnabled?: boolean;
}

export function createRealOnNewSignal(
  opts: RealAdmitOptions,
): (signal: Signal, ctx: { runId: string }) => Promise<void> {
  return async (signal, ctx) => {
    const ceiling = new TokenCeiling({ maxTotalTokens: opts.maxTokensPerRun });
    const claudeSession = withTokenCeiling(new RealClaudeSession(), ceiling);
    const codexSession = withTokenCeiling(new RealCodexSession(), ceiling);

    await runPlanPipeline({
      repoRoot: opts.repoRoot,
      worktreesRoot: opts.worktreesRoot,
      runsRoot: opts.runsRoot,
      description: buildDescription(signal),
      runId: ctx.runId,
      claudeSession,
      codexSession,
      ntfyUrl: opts.ntfyUrl,
      slackTarget: opts.slackTarget,
      notificationsEnabled: opts.notificationsEnabled ?? false,
    });
  };
}
