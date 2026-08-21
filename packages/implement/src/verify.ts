/**
 * verify.ts -- verification in a background session; the VERDICT is now
 * mechanically DERIVED from harness-recorded process exit codes, not
 * self-reported by a model.
 *
 * THE MOST SAFETY-CRITICAL FILE IN THIS PACKAGE. Quoting the M4 milestone
 * brief directly: "verification never runs in the session that wrote the
 * code. A background session returns a verdict, not a stack trace, so the
 * implementing session's context stays clean."
 *
 * Phase 3 rewrite -- WHY: prior to this, "verified" meant "a model said it
 * ran the tests and they passed" (`Verdict.outcome` was parsed straight out
 * of the model's own JSON response). That is a claim, not a measurement: it
 * launders a guess into an authoritative-looking green check, and fails
 * hardest in exactly the unattended case this whole system exists to create
 * -- a human stops watching precisely because they trust the check. Now:
 *
 *   - The HARNESS spawns every one of the project's configured validation
 *     commands itself (`runValidationCommands`, validation-commands.ts) and
 *     records each one's real exit code, duration, and a bounded/redacted
 *     output tail as a `CheckResult`.
 *   - `deriveVerdict` is the ONLY function in this codebase that can
 *     construct a `Verdict` (see its doc comment for the structural
 *     mechanism), and it computes `outcome` purely from those exit codes:
 *     `outcome` can never be "pass" while any `CheckResult.exitCode !== 0`.
 *   - The verifier model's role changes from "source of truth" to
 *     "optional summarizer": it is shown the ALREADY-RECORDED results and
 *     asked only to write a short human-readable explanation. It cannot set
 *     `outcome`, and a model call failing/timing out does not block the
 *     verdict -- the checks alone are sufficient to derive one.
 *
 * Two hard, code-enforced invariants carried over unchanged (not just doc
 * comments):
 *
 *   1. This function NEVER sets `resumeSessionId` on the `ModelRunOptions`
 *      it builds -- verification always starts a brand-new session/context,
 *      never resumes the implementer's. This is intentional and
 *      load-bearing: do not "helpfully" add session-resumption here later.
 *
 *   2. The fence epoch is checked BEFORE any harness work happens at all (a
 *      stale run must not even spend the time/side-effects of running
 *      validation commands) AND again AFTER the model call completes (an
 *      amendment/abort could have landed mid-verification) -- in that case
 *      the verdict is discarded, never returned, since a stale verdict must
 *      never reach the PR stage.
 *
 * `rawLogPath` still captures the model session's raw transport log to disk
 * as before; it is not the mechanism for capturing command evidence anymore
 * -- that's `CheckResult.outputTail`, recorded directly from the spawned
 * process, independent of anything the model says.
 */

import { DEFAULT_SESSION_DIRECTIVE, type ModelSession } from "@pros/plan";
import { loadRunState, StaleFenceError } from "@pros/barrier";
import type { TokenCeiling } from "@pros/lease";
import type { ValidationCommand } from "./project-config.js";
import { runValidationCommands, type CheckResult } from "./validation-commands.js";

/**
 * Unique, unexported brand key: only code in THIS module can produce an
 * object that structurally satisfies `Verdict` (see `Verdict`'s doc
 * comment). A REAL runtime `Symbol()` (not `declare const ... unique
 * symbol`, which is type-only and has no runtime value) because
 * `deriveVerdict`/`noCommitVerdict` use it as an actual computed property
 * key on the objects they build, and this package's tests run through `tsx`
 * (type-erasing, no `tsc` step), so the brand must exist at runtime too.
 */
const VERDICT_BRAND = Symbol("verdict-brand");

export interface Verdict {
  /** Not exported, not constructible outside this file -- see `deriveVerdict`. */
  readonly [VERDICT_BRAND]: true;
  outcome: "pass" | "fail";
  /** <= ~500 chars, human-readable. May include the verifier model's summary, but never determines `outcome`. */
  summary: string;
  /** Short labels, e.g. ["pnpm test: exit 1"] -- derived from `checks`, NOT raw stdout/stack traces. */
  failingChecks: string[];
  /** The exact harness-recorded evidence `outcome` was derived from. Empty iff the project has zero configured validation commands. */
  checks: CheckResult[];
  /** True iff `checks` is empty because the project's `ProjectConfig.validationCommands` is `[]` -- an explicit, visible fact for a decision-card UI to render distinctly from "N commands ran and passed", never a silent/indistinguishable pass. */
  noValidationCommandsConfigured: boolean;
}

export interface VerifyInput {
  /** MUST be a session the caller constructs FRESH for this call -- never the implementer's session. */
  verifierSession: ModelSession;
  worktreePath: string;
  runId: string;
  /** So this function can call loadRunState(runDir) to check the fence epoch. */
  runDir: string;
  /** Captured by the caller BEFORE this stage started. */
  expectedFenceEpoch: number;
  /** MUST be a fresh attemptId, never the implementer's attemptId or sessionId. */
  attemptId: string;
  /** The project's configured commands (project-config.ts), already resolved by the caller. `[]` is a legitimate, honest "none observed for this project" -- see `Verdict.noValidationCommandsConfigured`. */
  validationCommands: ValidationCommand[];
  rawLogPath?: string;
  tokenCeiling?: TokenCeiling;
  dangerouslySkipPermissions?: boolean;
  /** Per-command wall-clock ceiling, forwarded to `runValidationCommands`. Defaults to PROS_VALIDATION_TIMEOUT_MS / 10 minutes. */
  validationTimeoutMs?: number;
}

/**
 * Exported for API completeness with the original design sketch, but the
 * hard requirements below are explicit that a stale fence must surface as
 * `StaleFenceError` (imported from `@pros/barrier`) so callers can catch one
 * error type across the whole pipeline for "the run moved on underneath
 * this stage" -- this class is intentionally never thrown from this file.
 */
export class StaleVerificationError extends Error {}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

/** Parses only a `summary` string out of the model's response -- outcome/failingChecks are no longer requested from the model at all, so there is nothing for it to get wrong on that front. Falls back to an empty string rather than throwing: an unparseable summary must not block a verdict that harness-recorded exit codes already fully determine. */
function parseSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed?.summary === "string") return parsed.summary;
  } catch {
    // fall through
  }
  return "";
}

/**
 * The ONLY function in this codebase that can construct a `Verdict`. Every
 * other module is structurally unable to hand-assemble one: `Verdict`
 * requires a property keyed by the unexported `VERDICT_BRAND` symbol, which
 * no code outside this file can reference, so no external object literal
 * can satisfy the `Verdict` type -- only a value that flowed through this
 * function (or an explicit `as unknown as Verdict` escape hatch, which is
 * its own visible, grep-able admission of bypassing the mechanism, not an
 * accidental one). This is enforced by the TypeScript compiler at every call
 * site outside this module, not by a comment asking callers to be careful.
 *
 * `outcome` is computed purely from `checks[].exitCode`: "pass" iff no check
 * has a nonzero exit code. An empty `checks` array (no validation commands
 * configured for this project) is a VACUOUS pass -- logically consistent
 * ("every one of zero commands exited 0"), but never a SILENT one: the
 * returned `Verdict.noValidationCommandsConfigured` flag and `summary` text
 * both say so explicitly, so a decision-card UI (and a human) can always
 * tell "0 commands, vacuously green" apart from "N commands, all green".
 */
function deriveVerdict(checks: CheckResult[], modelSummary: string): Verdict {
  const failing = checks.filter((c) => c.exitCode !== 0);
  const noValidationCommandsConfigured = checks.length === 0;
  const outcome: "pass" | "fail" = failing.length === 0 ? "pass" : "fail";
  const failingChecks = failing.map((c) => `${c.label ?? c.command}: exit ${c.exitCode}${c.timedOut ? " (timed out)" : ""}`);

  let summary: string;
  if (noValidationCommandsConfigured) {
    summary = "no validation commands configured for this project -- nothing was executed; verdict is vacuously pass, not a measured one";
  } else if (failing.length > 0) {
    summary = `${failing.length}/${checks.length} validation command(s) failed: ${failingChecks.join("; ")}`;
  } else if (modelSummary.trim().length > 0) {
    summary = modelSummary.trim();
  } else {
    summary = `${checks.length} validation command(s) passed`;
  }

  return {
    [VERDICT_BRAND]: true,
    outcome,
    summary: summary.length > 500 ? `${summary.slice(0, 497)}...` : summary,
    failingChecks,
    checks,
    noValidationCommandsConfigured,
  };
}

/**
 * A `Verdict` for "there was nothing to verify" (e.g. the implementation
 * stage produced no commit at all) -- distinct from
 * `noValidationCommandsConfigured` (which means "this project legitimately
 * has zero configured commands", not "there was no change to check"). Goes
 * through the same brand as `deriveVerdict`: this file remains the only
 * place a `Verdict` can be constructed.
 */
export function noCommitVerdict(reason: string): Verdict {
  return {
    [VERDICT_BRAND]: true,
    outcome: "fail",
    summary: reason,
    failingChecks: [],
    checks: [],
    noValidationCommandsConfigured: false,
  };
}

export async function runVerification(input: VerifyInput): Promise<Verdict> {
  // Fence check BEFORE any harness work at all -- a stale run must not even
  // spend the time/side-effects of spawning validation commands.
  const before = await loadRunState(input.runDir);
  if (before.fenceEpoch !== input.expectedFenceEpoch) {
    throw new StaleFenceError("runVerification", input.expectedFenceEpoch, before.fenceEpoch);
  }

  // The harness, not the model, runs the project's own validation commands
  // and records what actually happened -- this IS the verification.
  const checks = await runValidationCommands({
    worktreePath: input.worktreePath,
    commands: input.validationCommands,
    timeoutMs: input.validationTimeoutMs,
  });

  const checksDescription =
    checks.length === 0
      ? "(no validation commands are configured for this project)"
      : checks
          .map((c) => `- ${c.label ?? c.command}: exit ${c.exitCode}${c.timedOut ? " (TIMED OUT)" : ""} (${c.durationMs}ms)\n  output tail:\n${c.outputTail}`)
          .join("\n");

  const prompt = [
    "You are summarizing the results of a completed implementation change's verification run.",
    DEFAULT_SESSION_DIRECTIVE,
    "The harness has ALREADY run this project's validation commands directly and recorded their real exit codes below -- you do NOT need to",
    "(and should not) re-run them yourself. Whether this change passes or fails is already mechanically determined by those exit codes; your",
    "job is only to explain, in plain language, what happened -- especially the likely cause of any failure -- for a human reviewer.",
    "",
    "Recorded validation command results:",
    checksDescription,
    "",
    'Report ONLY the following, matching the provided schema exactly: "summary" -- a short (<= 500 char), human-readable explanation.',
    "Keep it a SUMMARY, not a copy of the output tail above -- the harness already recorded that verbatim in the journal, so you don't need to",
    "reproduce it; just explain what it means.",
  ].join("\n");

  // Invariant 1 (load-bearing, see file doc comment): resumeSessionId is
  // deliberately never set here -- verification always starts fresh.
  let modelSummary = "";
  try {
    const result = await input.verifierSession.run({
      cwd: input.worktreePath,
      prompt,
      schema: SUMMARY_SCHEMA,
      attemptId: input.attemptId,
      rawLogPath: input.rawLogPath,
      dangerouslySkipPermissions: input.dangerouslySkipPermissions,
    });
    if (input.tokenCeiling) {
      input.tokenCeiling.record(result.usage);
    }
    modelSummary = parseSummary(result.text);
  } catch {
    // The verdict is already fully determined by `checks` -- a failed/timed-
    // out summarization call is a missing nicety, never a reason to fail
    // (or fail to produce) verification itself.
    modelSummary = "";
  }

  const verdict = deriveVerdict(checks, modelSummary);

  // Fence check AFTER the model call completes -- an amendment/abort could
  // have landed mid-verification. If so, the verdict must be discarded, not
  // returned: a stale verdict must never reach the PR stage.
  const after = await loadRunState(input.runDir);
  if (after.fenceEpoch !== input.expectedFenceEpoch) {
    throw new StaleFenceError("runVerification", input.expectedFenceEpoch, after.fenceEpoch);
  }

  return verdict;
}
