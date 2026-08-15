/**
 * verify.ts -- verification in a background session, returns a verdict only.
 *
 * THE MOST SAFETY-CRITICAL FILE IN THIS PACKAGE. Quoting the M4 milestone
 * brief directly: "verification never runs in the session that wrote the
 * code. A background session returns a verdict, not a stack trace, so the
 * implementing session's context stays clean."
 *
 * Two hard, code-enforced invariants (not just doc comments):
 *
 *   1. This function NEVER sets `resumeSessionId` on the `ModelRunOptions`
 *      it builds -- verification always starts a brand-new session/context,
 *      never resumes the implementer's. This is intentional and
 *      load-bearing: do not "helpfully" add session-resumption here later.
 *
 *   2. The fence epoch is checked BEFORE the model runs at all (a stale run
 *      must not even spend tokens) AND again AFTER the model call completes
 *      (an amendment/abort could have landed mid-verification) -- in that
 *      case the verdict is discarded, never returned, since a stale verdict
 *      must never reach the PR stage.
 *
 * The return type is `Verdict`, and ONLY `Verdict` -- no raw stdout, full
 * model response text, or stack trace ever leaves this function. Full raw
 * events/logs still get written to disk via `rawLogPath` (that's fine and
 * expected -- they're not lost, just never propagated into this function's
 * return value or thrown errors).
 */

import type { ModelSession } from "@pros/plan";
import { loadRunState, StaleFenceError } from "@pros/barrier";
import type { TokenCeiling } from "@pros/lease";

export interface Verdict {
  outcome: "pass" | "fail";
  /** <= ~500 chars, human-readable. */
  summary: string;
  /** Short labels, e.g. ["pnpm test: 2 failing", "pnpm typecheck: 3 errors"] -- NOT raw stdout/stack traces. */
  failingChecks: string[];
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
  rawLogPath?: string;
  tokenCeiling?: TokenCeiling;
}

/**
 * Exported for API completeness with the original design sketch, but the
 * hard requirements below are explicit that a stale fence must surface as
 * `StaleFenceError` (imported from `@pros/barrier`) so callers can catch one
 * error type across the whole pipeline for "the run moved on underneath
 * this stage" -- this class is intentionally never thrown from this file.
 */
export class StaleVerificationError extends Error {}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    failingChecks: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "summary", "failingChecks"],
} as const;

function parseVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`runVerification: model output was not valid JSON: ${(err as Error).message}`);
  }
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec?.outcome !== "string" ||
    (rec.outcome !== "pass" && rec.outcome !== "fail") ||
    typeof rec.summary !== "string" ||
    !Array.isArray(rec.failingChecks) ||
    !rec.failingChecks.every((c) => typeof c === "string")
  ) {
    throw new Error(`runVerification: malformed verdict response, expected {outcome, summary, failingChecks[]}`);
  }
  return {
    outcome: rec.outcome,
    summary: rec.summary,
    failingChecks: rec.failingChecks as string[],
  };
}

export async function runVerification(input: VerifyInput): Promise<Verdict> {
  // Fence check BEFORE running the model at all -- a stale run must not
  // even spend tokens.
  const before = await loadRunState(input.runDir);
  if (before.fenceEpoch !== input.expectedFenceEpoch) {
    throw new StaleFenceError("runVerification", input.expectedFenceEpoch, before.fenceEpoch);
  }

  const prompt = [
    "You are verifying a completed implementation change in the repository at the current working directory.",
    "Run this project's build/typecheck/test commands (e.g. `pnpm -r typecheck` and `pnpm -r test`, or the",
    "equivalent for this repo if it isn't a pnpm/TS repo) and determine whether the change is correct.",
    "",
    "Report ONLY the following, matching the provided schema exactly:",
    '  - "outcome": "pass" or "fail"',
    '  - "summary": a short (<= 500 char), human-readable summary',
    '  - "failingChecks": an array of short labels for any failing checks (e.g. "pnpm test: 2 failing")',
    "",
    "Do NOT paste raw command output, stack traces, or logs into your response -- only the short summary/labels above.",
  ].join("\n");

  // Invariant 1 (load-bearing, see file doc comment): resumeSessionId is
  // deliberately never set here -- verification always starts fresh.
  const result = await input.verifierSession.run({
    cwd: input.worktreePath,
    prompt,
    schema: VERDICT_SCHEMA,
    attemptId: input.attemptId,
    rawLogPath: input.rawLogPath,
  });

  if (input.tokenCeiling) {
    input.tokenCeiling.record(result.usage);
  }

  // Fail closed: an unparseable verdict must never look like success.
  const verdict = parseVerdict(result.text);

  // Fence check AFTER the model call completes -- an amendment/abort could
  // have landed mid-verification. If so, the verdict must be discarded, not
  // returned: a stale verdict must never reach the PR stage.
  const after = await loadRunState(input.runDir);
  if (after.fenceEpoch !== input.expectedFenceEpoch) {
    throw new StaleFenceError("runVerification", input.expectedFenceEpoch, after.fenceEpoch);
  }

  return verdict;
}
