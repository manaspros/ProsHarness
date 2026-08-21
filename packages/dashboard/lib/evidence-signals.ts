/**
 * evidence-signals.ts -- the four binary decision-card signals shared by
 * the Gate 1 (plan) and Gate 2 (review) decision cards.
 *
 * Phase 5a's whole reason for existing (per the brief): stop gating a human
 * decision on a model's self-reported confidence percentage, which is
 * uncalibrated and peaks exactly when the model has misread the problem.
 * Instead: four independently-checkable facts, three of them measured by
 * the harness (never asserted by a model), one advisory.
 *
 * "Reproduced" and "Fix proven" read `validation_checks` rows written from
 * the `validation_command_run` journal event (packages/index/src/schema.ts,
 * rebuild.ts). Only `role: "gate"` is written by the harness today -- the
 * reproduce-before/after flow is schema-ready but not yet wired up by any
 * producer. That means, for every run in this codebase RIGHT NOW, these two
 * signals will read `"not_established"` -- and that is the correct,
 * load-bearing answer, not a bug in this file. Rendering "not established"
 * identically to "false" would recreate exactly the defect this phase
 * exists to close (a green check laundering the absence of a check).
 */
import type Database from "better-sqlite3";
import { parseLatestEventOfKind, type VerifyVerdictPayload } from "./review-data.js";

export type SignalState = "pass" | "fail" | "not_established";

export type CodexAdvisoryStatus = "reviewed_no_blocker" | "reviewed_blocker" | "unavailable";

export interface CodexAdvisoryPayload {
  status: CodexAdvisoryStatus;
  findingsJson?: string;
  unavailableReason?: string;
}

export interface EvidenceSignals {
  reproduced: SignalState;
  fixProven: SignalState;
  gatesGreen: SignalState;
  /** Advisory only -- never gates anything, per the codex advisory review's own contract (packages/implement/src/review.ts). */
  independentlyReviewed: SignalState;
}

export type Confidence = "low" | "medium" | "high";

interface ValidationCheckRow {
  role: string;
  exit_code: number;
  timed_out: number;
}

/** Reads every validation_checks row for this run with the given role, ordered oldest-first (irrelevant to the pass/fail computation, but deterministic). */
function readChecksByRole(db: Database.Database, runId: string, role: string): ValidationCheckRow[] {
  return db
    .prepare(`SELECT role, exit_code, timed_out FROM validation_checks WHERE run_id = ? AND role = ? ORDER BY seq ASC`)
    .all(runId, role) as ValidationCheckRow[];
}

/** true iff every recorded check in the list exited 0 and did not time out. */
function allGreen(rows: ValidationCheckRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.exit_code === 0 && r.timed_out === 0);
}

/**
 * Computes the four evidence signals for a run from already-rebuilt index
 * tables. Pure with respect to its inputs (a `db` handle) -- no
 * model-reported field is ever consulted for `reproduced`/`fixProven`/
 * `gatesGreen`; `independentlyReviewed` is explicitly the one advisory
 * exception and is labelled as such in `EvidenceSignals`'s doc comment.
 */
export function getEvidenceSignals(db: Database.Database, runId: string): EvidenceSignals {
  const before = readChecksByRole(db, runId, "reproduce_before");
  const after = readChecksByRole(db, runId, "reproduce_after");

  // "Reproduced" means a command demonstrated the failure -- i.e. at least
  // one reproduce_before command actually FAILED (nonzero exit). A
  // reproduce_before command that exited 0 recorded that the bug did NOT
  // manifest, which is itself a meaningful, distinct fact from "no attempt
  // was ever made" -- so it renders as "fail", never collapsed into
  // "not_established".
  let reproduced: SignalState;
  if (before.length === 0) {
    reproduced = "not_established";
  } else {
    reproduced = before.some((r) => r.exit_code !== 0) ? "pass" : "fail";
  }

  // Hard rule, expressed in code (not just a comment): a fix cannot be
  // "proven" for a bug that was never demonstrated. This dependency is
  // checked BEFORE looking at any reproduce_after rows at all.
  let fixProven: SignalState;
  if (reproduced !== "pass") {
    fixProven = "not_established";
  } else if (after.length === 0) {
    fixProven = "not_established";
  } else {
    fixProven = allGreen(after) ? "pass" : "fail";
  }

  // gatesGreen trusts the ALREADY-DERIVED verify_verdict outcome
  // (packages/implement/src/verify.ts's deriveVerdict, the one function in
  // this codebase permitted to construct a Verdict) -- this file must not
  // re-derive pass/fail from raw exit codes a second time.
  const verdict = parseLatestEventOfKind<VerifyVerdictPayload>(db, runId, "verify_verdict");
  const gatesGreen: SignalState = !verdict ? "not_established" : verdict.outcome === "pass" ? "pass" : "fail";

  const codexAdvisory = parseLatestEventOfKind<CodexAdvisoryPayload>(db, runId, "codex_advisory_review");
  let independentlyReviewed: SignalState;
  if (!codexAdvisory || codexAdvisory.status === "unavailable") {
    // "unavailable" must never render as reviewed-and-clean.
    independentlyReviewed = "not_established";
  } else {
    independentlyReviewed = codexAdvisory.status === "reviewed_no_blocker" ? "pass" : "fail";
  }

  return { reproduced, fixProven, gatesGreen, independentlyReviewed };
}

/**
 * Confidence is derived, never model-reported, and is capped by the hard
 * rule from the brief: "without Reproduced, confidence caps at medium
 * regardless of the rest." A failing (not merely absent) gate always caps
 * at "low" outright -- a passing gate is the one signal a decision card
 * cannot responsibly soften.
 */
export function computeConfidence(signals: EvidenceSignals): Confidence {
  if (signals.gatesGreen !== "pass") return "low";

  const passCount = [signals.reproduced, signals.fixProven, signals.independentlyReviewed].filter(
    (s) => s === "pass",
  ).length;

  let level: Confidence = passCount >= 3 ? "high" : passCount >= 1 ? "medium" : "low";

  // The hard rule, enforced structurally, not just by the strength count
  // above (which could change shape later without anyone noticing this
  // invariant broke): confidence can never read "high" without Reproduced.
  if (signals.reproduced !== "pass" && level === "high") {
    level = "medium";
  }

  return level;
}
