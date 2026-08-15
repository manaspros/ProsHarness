import { Journal, loadRunState } from "@pros/barrier";
import type { ModelSession, ModelUsage } from "./model-session.js";
import type { Finding } from "./finding.js";
import { draftPlan, revisePlan, type PlanDoc } from "./plan.js";
import { independentAssessment, critiqueObjections, type Objection } from "./critique.js";

/**
 * docs/03-architecture.md's stated default. Two rounds (an initial
 * independent critique, plus exactly one follow-up re-attack on whatever
 * is still unresolved) is enough to catch the "Claude ignored/misread an
 * objection" case without letting a single-user system's debate loop keep
 * spending quota chasing diminishing-returns nitpicks; a genuinely stuck
 * disagreement after two rounds is better surfaced to the human via the
 * checkpoint barrier than resolved by a third or fourth automated round.
 */
export const DEBATE_ROUND_CAP = 2;

/**
 * Per-run token ceiling (admission control, D21). This is a single-person
 * system (D1): there is no multi-tenant budget to protect, but a runaway
 * debate (e.g. Codex and Claude ping-ponging on a genuinely unresolvable
 * disagreement) can otherwise quietly burn a meaningful fraction of a
 * weekly subscription's usage pool on ONE run. 300,000 tokens is chosen as
 * "generous for a real plan+critique debate on a normal-sized finding, but
 * nowhere near a full weekly allowance" -- a real draft+critique+revise
 * round on a small-to-medium finding is observed (informally, from manual
 * runs) to cost on the order of tens of thousands of tokens, so this
 * ceiling comfortably covers a full DEBATE_ROUND_CAP-round debate while
 * still tripping well before a pathological loop could matter. Configurable
 * per-call (see RunDebateOptions.tokenCeiling) rather than hardcoded, since
 * "configurable with a documented default" is strictly more useful for
 * tests and future tuning than a bare constant.
 */
export const PER_RUN_TOKEN_CEILING = 300_000;

export interface DebateResult {
  finalPlan: PlanDoc;
  /** Full objection history across all rounds -- never mutated away, only annotated with `resolution`. */
  allObjections: Objection[];
  /** What's left open (not "accepted") at the end. */
  unresolvedObjections: Objection[];
  roundsRun: number;
  /** Set if the loop stopped due to a hard limit rather than natural convergence. */
  cappedReason?: string;
  totalUsage: ModelUsage;
}

export interface RunDebateOptions {
  claudeSession: ModelSession;
  codexSession: ModelSession;
  cwd: string;
  finding: Finding;
  journal: Journal;
  runId: string;
  attemptIdPrefix: string;
  /**
   * DEVIATION from the literal spec'd signature: `loadRunState` needs the
   * run's directory on disk, not just an open `Journal` handle (`Journal`
   * doesn't expose its own path). `runDir` is added here so this function
   * can derive the run's real current fence epoch itself, per
   * packages/worktree/src/allocator.ts's pattern, instead of a hardcoded 0.
   */
  runDir: string;
  roundCap?: number;
  tokenCeiling?: number;
  dangerouslySkipPermissions?: boolean;
  /** Maps each model attempt id to its live stream-json log path. */
  rawLogPathForAttempt?: (attemptId: string) => string;
}

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

function totalTokens(u: ModelUsage): number {
  return u.inputTokens + u.outputTokens;
}

function isOpen(o: Objection): boolean {
  return o.resolution !== "accepted";
}

function isBlocking(o: Objection): boolean {
  return (o.severity === "blocker" || o.severity === "major") && isOpen(o);
}

/**
 * Match a revised plan's self-reported `objectionResolutions` (see
 * plan.ts's revisePlan schema) back onto the `Objection`s that were sent to
 * it, by exact claim-string match. An objection the model didn't
 * acknowledge at all is left as "unresolved" -- safer than assuming
 * acceptance.
 */
function applyResolutions(objections: Objection[], revised: PlanDoc): void {
  const structured = revised.structured as { objectionResolutions?: Array<{ claim: string; resolution: string }> };
  const resolutions = structured?.objectionResolutions ?? [];
  const byClaim = new Map(resolutions.map((r) => [r.claim, r.resolution]));
  for (const o of objections) {
    const r = byClaim.get(o.claim);
    if (r === "accepted" || r === "rejected") {
      o.resolution = r;
    }
  }
}

/**
 * Wraps a ModelSession so every `run()` call's usage is accumulated into
 * `sink`. draftPlan/revisePlan/independentAssessment/critiqueObjections
 * return domain objects (PlanDoc/Objection[]/etc), not raw ModelRunResult,
 * so this is the seam that lets `runDebate` still total up "every
 * ModelRunResult.usage from every call made in this function" without
 * threading usage through every wrapper function's return type.
 */
function trackingSession(session: ModelSession, sink: { total: ModelUsage }): ModelSession {
  return {
    provider: session.provider,
    async run(runOpts) {
      const result = await session.run(runOpts);
      sink.total = addUsage(sink.total, result.usage);
      return result;
    },
  };
}

export async function runDebate(opts: RunDebateOptions): Promise<DebateResult> {
  const roundCap = opts.roundCap ?? DEBATE_ROUND_CAP;
  const tokenCeiling = opts.tokenCeiling ?? PER_RUN_TOKEN_CEILING;
  const { journal, runId } = opts;

  // Derived once, like allocator.ts's saga does -- reused for every entry
  // this debate appends, since it's all one logical run-transition.
  const fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;

  const usageSink = { total: { inputTokens: 0, outputTokens: 0 } as ModelUsage };
  const claudeSession = trackingSession(opts.claudeSession, usageSink);
  const codexSession = trackingSession(opts.codexSession, usageSink);
  const allObjections: Objection[] = [];
  let cappedReason: string | undefined;
  const rawLogPath = (attemptId: string): string | undefined => opts.rawLogPathForAttempt?.(attemptId);

  // Step 2: genuinely concurrent, independent first opinions.
  const [plan, assessmentResult] = await Promise.all([
    draftPlan(claudeSession, {
      cwd: opts.cwd,
      finding: opts.finding,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      rawLogPath: rawLogPath(`${opts.attemptIdPrefix}-draft-v1`),
      attemptId: `${opts.attemptIdPrefix}-draft-v1`,
    }),
    independentAssessment(codexSession, {
      cwd: opts.cwd,
      finding: opts.finding,
      rawLogPath: rawLogPath(`${opts.attemptIdPrefix}-assess`),
      attemptId: `${opts.attemptIdPrefix}-assess`,
    }),
  ]);
  let currentPlan = plan;

  await journal.append({
    runId,
    fenceEpoch,
    kind: "plan_drafted",
    planId: currentPlan.planId,
    version: currentPlan.version,
    markdown: currentPlan.markdown,
    structuredJson: JSON.stringify(currentPlan.structured),
  });
  await journal.append({
    runId,
    fenceEpoch,
    kind: "critique_independent",
    planId: currentPlan.planId,
    round: 1,
    assessmentJson: JSON.stringify(assessmentResult.assessment),
  });

  // Step 3: round-1 critique, given Codex's own prior assessment + Claude's v1 plan.
  let round = 1;
  let objections = await critiqueObjections(codexSession, {
    cwd: opts.cwd,
    finding: opts.finding,
    independentAssessment: assessmentResult.assessment,
    plan: currentPlan,
    rawLogPath: rawLogPath(`${opts.attemptIdPrefix}-critique-r${round}`),
    attemptId: `${opts.attemptIdPrefix}-critique-r${round}`,
  });
  allObjections.push(...objections);
  await journal.append({
    runId,
    fenceEpoch,
    kind: "critique_objections",
    planId: currentPlan.planId,
    round,
    objectionsJson: JSON.stringify({ objections }),
  });

  // Step 4: bounded revise/re-attack loop. The ceiling is a PRE-FLIGHT gate:
  // checked before making the next call, never audited after the fact.
  while (round <= roundCap && objections.some(isBlocking)) {
    if (totalTokens(usageSink.total) >= tokenCeiling) {
      cappedReason = `per-run token ceiling (${tokenCeiling}) reached before round ${round}'s revision could run`;
      break;
    }

    const unresolvedForThisRound = objections.filter(isBlocking);
    const revised = await revisePlan(claudeSession, {
      cwd: opts.cwd,
      finding: opts.finding,
      previous: currentPlan,
      objections: unresolvedForThisRound,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      rawLogPath: rawLogPath(`${opts.attemptIdPrefix}-revise-r${round}`),
      attemptId: `${opts.attemptIdPrefix}-revise-r${round}`,
    });
    applyResolutions(objections, revised);
    currentPlan = revised;
    await journal.append({
      runId,
      fenceEpoch,
      kind: "plan_revised",
      planId: currentPlan.planId,
      version: currentPlan.version,
      markdown: currentPlan.markdown,
      structuredJson: JSON.stringify(currentPlan.structured),
      round,
    });

    const stillBlocking = objections.filter(isBlocking);
    if (stillBlocking.length === 0) {
      // Converged naturally.
      break;
    }

    if (round >= roundCap) {
      cappedReason = `debate round cap (${roundCap}) reached with ${stillBlocking.length} unresolved blocker/major objection(s) remaining`;
      break;
    }

    if (totalTokens(usageSink.total) >= tokenCeiling) {
      cappedReason = `per-run token ceiling (${tokenCeiling}) reached before round ${round + 1}'s re-critique could run`;
      break;
    }

    round += 1;
    const nextObjections = await critiqueObjections(codexSession, {
      cwd: opts.cwd,
      finding: opts.finding,
      independentAssessment: assessmentResult.assessment,
      plan: currentPlan,
      unresolvedOnly: stillBlocking,
      rawLogPath: rawLogPath(`${opts.attemptIdPrefix}-critique-r${round}`),
      attemptId: `${opts.attemptIdPrefix}-critique-r${round}`,
    });
    allObjections.push(...nextObjections);
    await journal.append({
      runId,
      fenceEpoch,
      kind: "critique_objections",
      planId: currentPlan.planId,
      round,
      objectionsJson: JSON.stringify({ objections: nextObjections }),
    });
    objections = nextObjections;
  }

  if (!cappedReason && round >= roundCap && objections.some(isBlocking)) {
    cappedReason = `debate round cap (${roundCap}) reached with unresolved blocker/major objection(s) remaining`;
  }

  if (cappedReason) {
    await journal.append({
      runId,
      fenceEpoch,
      kind: "debate_capped",
      planId: currentPlan.planId,
      roundsRun: round,
      reason: cappedReason,
    });
  }

  const unresolvedObjections = allObjections.filter(isOpen);
  await journal.append({
    runId,
    fenceEpoch,
    kind: "plan_finalized",
    planId: currentPlan.planId,
    version: currentPlan.version,
    unresolvedObjectionsJson: JSON.stringify(unresolvedObjections),
  });

  return {
    finalPlan: currentPlan,
    allObjections,
    unresolvedObjections,
    roundsRun: round,
    cappedReason,
    totalUsage: usageSink.total,
  };
}
