/**
 * validation-commands.ts -- the harness spawns a project's own validation
 * commands itself and records what actually happened, in process/exit-code
 * terms. Exists to close the gap the M4 verify stage originally had: a model
 * SELF-REPORTING "I ran the tests and they passed" is not evidence, it's a
 * claim. This module is the evidence-producing half; `verify.ts`'s
 * `deriveVerdict` is the evidence-consuming half that turns these results
 * into a `Verdict` with no other path to `outcome: "pass"`.
 *
 * Reuses `@pros/barrier`'s `spawnWithTimeout` (the same timeout+process-group-
 * kill primitive `runGit` sits on) rather than writing new spawn code -- a
 * validation command that hangs must become a recorded failure, never
 * silence, exactly the lesson `packages/barrier/src/git.ts` already
 * documents for git commits.
 */

import { spawnWithTimeout } from "@pros/barrier";
import type { ValidationCommand } from "./project-config.js";

/**
 * Hard cap on how much of a command's combined stdout+stderr is retained in
 * `CheckResult.outputTail` (and therefore in the journal). A verbose test
 * run can produce megabytes of output; the journal is meant to hold
 * decision-relevant evidence, not a full log dump -- `rawLogPath`-style full
 * capture is deliberately out of scope here. Chosen generously enough to
 * carry a failing test's actual assertion output, small enough that a dozen
 * validation commands per run stay a rounding error against journal size.
 */
export const OUTPUT_TAIL_MAX_CHARS = 4000;

/** Sentinel exit code recorded when a command times out or fails to spawn at all -- guarantees "nonzero exit code => not passing" covers these cases too, without deriveVerdict needing a separate special case. */
export const ABNORMAL_EXIT_CODE = -1;

/** Wall-clock ceiling per validation command. Overridable via PROS_VALIDATION_TIMEOUT_MS, mirroring git.ts's PROS_GIT_TIMEOUT_MS convention. Generous default: a real `pnpm -r test` or `cargo test` run can legitimately take minutes. */
const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

function validationTimeoutMsFromEnv(): number {
  const raw = process.env.PROS_VALIDATION_TIMEOUT_MS;
  if (!raw) return DEFAULT_VALIDATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VALIDATION_TIMEOUT_MS;
}

/**
 * Best-effort redaction of credential-looking substrings before ANYTHING
 * from a validation command's output reaches the journal. This is
 * defense-in-depth, not a guarantee -- a test that legitimately prints a
 * real secret in an unrecognized shape will still leak it. Patterns cover
 * the common, high-confidence shapes: cloud/vendor token prefixes, PEM
 * private key blocks, bearer/authorization headers, and
 * `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=`-shaped env assignments.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]")
    .replace(/\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._-]{10,}/gi, "$1 [REDACTED]")
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*)\s*=\s*\S+/g, "$1=[REDACTED]");
}

/** Last `OUTPUT_TAIL_MAX_CHARS` characters of a command's combined output, redacted. The TAIL (not the head) is kept because a failing test's actual assertion/stack trace is almost always at the end of the stream. */
function boundedOutputTail(stdout: string, stderr: string): string {
  const combined = stderr.trim().length > 0 ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  const redacted = redactSecrets(combined);
  return redacted.length > OUTPUT_TAIL_MAX_CHARS ? redacted.slice(-OUTPUT_TAIL_MAX_CHARS) : redacted;
}

/**
 * One project validation command's harness-observed outcome. `exitCode` is
 * always a real number (never null) -- timeouts and spawn failures are
 * normalized to `ABNORMAL_EXIT_CODE` so every downstream consumer can use
 * the single rule "exitCode !== 0 => not passing" without a second branch
 * for `timedOut`. `timedOut` is kept alongside for accurate display/labels.
 */
export interface CheckResult {
  command: string;
  label?: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/**
 * Runs `commands` IN ORDER (project-config.ts: "Ordered; run in sequence"),
 * via a shell (`sh -c`) since a `ValidationCommand.command` is a full
 * human-typed command line (e.g. "cargo test --locked"), not a bare
 * executable + argv. `worktreePath` is the cwd for every command -- the
 * harness verifies the WORKTREE's state, never ProsHarness's own repo.
 *
 * Does not stop early on the first failure: a later command's result is
 * still evidence (e.g. "typecheck failed AND tests failed" vs. "only tests
 * failed" materially changes the summary a human gets), and the M4 pipeline
 * already treats any single failing check as disqualifying for a PR.
 */
export async function runValidationCommands(opts: {
  worktreePath: string;
  commands: ValidationCommand[];
  timeoutMs?: number;
}): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? validationTimeoutMsFromEnv();
  const results: CheckResult[] = [];

  for (const vc of opts.commands) {
    try {
      const result = await spawnWithTimeout({
        command: vc.command,
        args: [],
        cwd: opts.worktreePath,
        timeoutMs,
        shell: true,
      });
      results.push({
        command: vc.command,
        label: vc.label,
        exitCode: result.timedOut ? ABNORMAL_EXIT_CODE : (result.exitCode ?? ABNORMAL_EXIT_CODE),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: boundedOutputTail(result.stdout, result.stderr),
      });
    } catch (err) {
      // spawnWithTimeout only rejects on a maxBuffer overflow or a spawn-level
      // error (e.g. the shell itself couldn't start) -- both are still a
      // recordable "this check did not pass", never a reason to abort the
      // whole verification stage silently.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        command: vc.command,
        label: vc.label,
        exitCode: ABNORMAL_EXIT_CODE,
        timedOut: false,
        durationMs: 0,
        outputTail: redactSecrets(message).slice(-OUTPUT_TAIL_MAX_CHARS),
      });
    }
  }

  return results;
}
