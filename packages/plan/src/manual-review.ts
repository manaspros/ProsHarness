import type { ModelSession } from "./model-session.js";
import type { Finding } from "./finding.js";
import { independentAssessment, critiqueObjections, type Objection } from "./critique.js";
import { revisePlan, type PlanDoc } from "./plan.js";

export interface ManualAdversarialReviewOptions {
  claudeSession: ModelSession;
  codexSession: ModelSession;
  cwd: string;
  finding: Finding;
  currentPlan: PlanDoc;
  attemptIdPrefix: string;
  /** Optional Claude session to resume. Defaults to currentPlan.sessionId. */
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  rawLogPathForAttempt?: (attemptId: string) => string;
}

export interface ManualAdversarialReviewResult {
  assessment: unknown;
  objections: Objection[];
  revisedPlan: PlanDoc;
  claudeSessionId?: string;
}

/**
 * Run the on-demand Codex challenge flow for an already-drafted plan.
 *
 * The order is intentional: Codex first forms an independent assessment,
 * then critiques the actual plan, and only then does Claude resume its prior
 * session to apply the review. No model is constructed here, which keeps the
 * function suitable for dashboard callers and deterministic fake-session tests.
 */
export async function runManualAdversarialReview(
  opts: ManualAdversarialReviewOptions,
): Promise<ManualAdversarialReviewResult> {
  const { assessment } = await independentAssessment(opts.codexSession, {
    cwd: opts.cwd,
    finding: opts.finding,
    rawLogPath: opts.rawLogPathForAttempt?.(`${opts.attemptIdPrefix}-assess`),
    attemptId: `${opts.attemptIdPrefix}-assess`,
  });
  const objections = await critiqueObjections(opts.codexSession, {
    cwd: opts.cwd,
    finding: opts.finding,
    independentAssessment: assessment,
    plan: opts.currentPlan,
    rawLogPath: opts.rawLogPathForAttempt?.(`${opts.attemptIdPrefix}-critique`),
    attemptId: `${opts.attemptIdPrefix}-critique`,
  });
  const revisedPlan = await revisePlan(opts.claudeSession, {
    cwd: opts.cwd,
    finding: opts.finding,
    previous: opts.currentPlan,
    objections,
    resumeSessionId: opts.resumeSessionId ?? opts.currentPlan.sessionId,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    rawLogPath: opts.rawLogPathForAttempt?.(`${opts.attemptIdPrefix}-revise`),
    attemptId: `${opts.attemptIdPrefix}-revise`,
  });

  return {
    assessment,
    objections,
    revisedPlan,
    claudeSessionId: revisedPlan.sessionId,
  };
}
