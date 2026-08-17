/**
 * Data-shaping helpers for the M5 review page. Small, mostly-pure functions
 * operating on already-queried rows (mirrors lib/plan-doc.ts's style), so
 * they're directly unit-testable without spinning up a Next.js request.
 *
 * Where these inputs come from (see the M5 brief): @pros/implement's
 * runGate2Pipeline (M4) journals three loosely-typed entries --
 * verify_verdict, review_completed, pr_create_intent/pr_created -- via the
 * same "unknown kinds pass through untouched" tolerant-parsing convention
 * already used for pr_create_intent/pr_created (see packages/implement/src/
 * pipeline.ts's file doc comment). @pros/index's rebuildIndex indexes EVERY
 * journal entry into the `events` table unconditionally, before its
 * kind-specific switch (packages/index/src/rebuild.ts's indexJournalEntries)
 * -- so these three kinds are already present as rows with
 * kind = "verify_verdict" / "review_completed" / "pr_created" and a
 * payload_json column holding the full JSON. We query that directly.
 */
import type Database from "better-sqlite3";
import { rankHunks, buildFocusChecklist, type RiskRankedDiff, type ChecklistItem } from "@pros/review";
import { isGate2StoppedError, type Gate2PipelineResultLike } from "./gate2.js";

/**
 * Queries `events` for the highest-`seq` row of the given kind for this
 * run, and JSON-parses its payload_json as T. A run could in theory retry
 * Gate 2 and produce more than one row of a given kind (e.g. a re-run after
 * a failing verify_verdict) -- the LATEST one (highest seq) is the current
 * fact, per the brief.
 */
export function parseLatestEventOfKind<T>(db: Database.Database, runId: string, kind: string): T | undefined {
  const row = db
    .prepare(`SELECT payload_json FROM events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`)
    .get(runId, kind) as { payload_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.payload_json) as T;
}

export interface PlanOperationStatus {
  operation: "plan_pipeline" | "codex_review" | "claude_refinement" | "implementation";
  state: "running" | "success" | "failed" | "stopped";
  error?: string;
  result?: Gate2PipelineResultLike;
}

/** Returns the latest durable plan/implementation operation transition. */
export function getPlanOperationStatus(db: Database.Database, runId: string): PlanOperationStatus | undefined {
  const row = db
    .prepare(
      `SELECT kind, payload_json FROM events WHERE run_id = ? AND kind IN ('plan_operation_started', 'plan_operation_completed') ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId) as { kind: string; payload_json: string } | undefined;
  if (!row) return undefined;
  const payload = JSON.parse(row.payload_json) as {
    operation?: PlanOperationStatus["operation"];
    outcome?: "success" | "failed" | "stopped";
    error?: string;
    result?: Gate2PipelineResultLike;
  };
  if (!payload.operation) return undefined;
  const stopped = payload.outcome === "stopped" || Boolean(payload.result?.aborted) || isGate2StoppedError(payload.error);
  const error = payload.error ?? (payload.result?.aborted
    ? `Gate 2 stopped during ${payload.result.aborted.stage}: ${payload.result.aborted.reason}`
    : undefined);
  return {
    operation: payload.operation,
    state: row.kind === "plan_operation_started" ? "running" : stopped ? "stopped" : payload.outcome ?? "failed",
    error,
    result: payload.result,
  };
}

export interface WorktreeInfo {
  repoRoot: string;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
}

/**
 * Reads the `worktrees` table for this run. A run could theoretically have
 * more than one allocation row (the schema allows it, per
 * packages/index/src/schema.ts's UNIQUE(run_id, allocation_id) -- distinct
 * allocation_ids are legal for the same run). Our choice (documented here,
 * per the brief's "document your choice"): prefer the row whose `state` is
 * "confirmed" (the terminal "this worktree really was used" state written
 * by rebuild.ts's worktree_confirmed handling); if none is confirmed, fall
 * back to the first row found. If there are zero rows, return undefined
 * (the caller's "no worktree yet" case).
 */
export function getWorktreeInfo(db: Database.Database, runId: string): WorktreeInfo | undefined {
  const rows = db
    .prepare(`SELECT repo_root, worktree_path, branch, base_sha, state FROM worktrees WHERE run_id = ?`)
    .all(runId) as Array<{ repo_root: string | null; worktree_path: string | null; branch: string | null; base_sha: string | null; state: string }>;
  if (rows.length === 0) return undefined;
  const chosen = rows.find((r) => r.state === "confirmed") ?? rows[0]!;
  if (!chosen.repo_root) return undefined; // no usable repoRoot recorded (e.g. only a rollback row) -- nothing rankHunks could run against
  return {
    repoRoot: chosen.repo_root,
    worktreePath: chosen.worktree_path,
    branch: chosen.branch,
    baseSha: chosen.base_sha,
  };
}

export interface VerifyVerdictPayload {
  outcome: "pass" | "fail";
  summary: string;
  failingChecksJson: string;
}

export interface ReviewCompletedPayload {
  verdict: "approve" | "blockers-present";
  objectionsJson: string;
  unresolvedBlockersJson: string;
}

export interface PrCreatedPayload {
  url: string;
  number: number;
  headSha: string;
}

export interface ComputeReviewDataOptions {
  /**
   * ALWAYS the worktree row's repo_root (the original parent repo), NEVER
   * worktreePath -- see the file-level note below. This is the one
   * non-obvious correctness point in this whole feature.
   */
  repoRoot: string;
  baseSha: string;
  headSha: string;
  verdict?: VerifyVerdictPayload;
  review?: ReviewCompletedPayload;
}

/**
 * WHY repoRoot, never worktreePath: after a successful Gate 2 pipeline run
 * with reapWorktreeOnSuccess: true, the worktree's local directory may no
 * longer exist on disk at all -- but the commits are NOT lost, because a
 * git worktree shares the SAME object database as its parent repo
 * (`.git/worktrees/<name>` is just a pointer into the parent's objects/
 * refs). So `git diff baseSha headSha` run with cwd = repoRoot (the
 * original parent repo) can still resolve both shas even after
 * `git worktree remove` deleted worktreePath entirely. rankHunks/
 * buildFocusChecklist take a repoRoot, never a worktreePath, for exactly
 * this reason -- callers of this function must pass the worktree row's
 * repo_root column, not its worktree_path column.
 */
export function computeReviewData(opts: ComputeReviewDataOptions): { riskRankedDiff: RiskRankedDiff; checklist: ChecklistItem[] } {
  const failingChecks: string[] = opts.verdict ? safeParseJsonArray<string>(opts.verdict.failingChecksJson) : [];
  const objections: Array<{ severity: string; claim: string }> = opts.review
    ? safeParseJsonArray<{ severity: string; claim: string }>(opts.review.objectionsJson)
    : [];

  const rankOpts = {
    repoRoot: opts.repoRoot,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    verificationFailingChecks: failingChecks,
    reviewObjections: objections,
  };

  const riskRankedDiff = rankHunks(rankOpts);
  const checklist = buildFocusChecklist(riskRankedDiff, rankOpts);
  return { riskRankedDiff, checklist };
}

function safeParseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
