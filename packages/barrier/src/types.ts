/**
 * Shared types for the checkpoint barrier (M1).
 *
 * Scope: attempt identity, the durable journal, manifests, fence epochs,
 * and the checkpoint state machine described in docs/03-architecture.md.
 * No SQLite, no plans, no worktree allocator beyond identity.
 */

export type AnswerEffect =
  | "continue_within_approved_plan"
  | "requires_plan_amendment"
  | "abort";

/**
 * The checkpoint sub-state machine (docs/03-architecture.md):
 *   running -> checkpoint_requested -> quiescing -> parked
 *   parked -> answered -> claimed -> resuming -> consumed -> running(resume_phase)
 */
export type RunPhase =
  | "running"
  | "checkpoint_requested"
  | "quiescing"
  | "parked"
  | "answered"
  | "claimed"
  | "resuming"
  | "consumed"
  | "interrupted"
  | "failed";

export interface JournalEntryBase {
  /** Monotonic per-run sequence number, assigned by the single serialized writer. */
  seq: number;
  /** Wall-clock time, ISO-8601. Not authoritative for ordering: seq is. */
  ts: string;
  runId: string;
  /** The fence epoch in effect when this entry was durably appended. */
  fenceEpoch: number;
}

export type JournalEntry = JournalEntryBase &
  (
    | { kind: "attempt_started"; attemptId: string; cwd: string; launchConfigHash: string; unitName: string }
    | { kind: "attempt_ended"; attemptId: string; exitReason: string }
    | {
        kind: "checkpoint_requested";
        checkpointId: string;
        attemptId: string;
        questionId: string;
        idempotencyKey: string;
        prompt: string;
        options: string[];
        /** Which human gate this is. Defaults to "ask_human" when absent (old journal entries, and plain ask_human calls). */
        gateType?: "ask_human" | "plan_approval" | "pr_review";
        /** Present only when gateType is "plan_approval": which plan version this approval gate concerns. */
        planRef?: { planId: string; version: number };
        /** Present only when gateType is "pr_review" (M4 Gate 2): which draft PR this review gate concerns. */
        prRef?: { url: string; number: number; headSha: string };
      }
    | { kind: "quiescing"; checkpointId: string; attemptId: string }
    | {
        kind: "parked";
        checkpointId: string;
        attemptId: string;
        manifestPath: string;
        workingStateHash: string;
      }
    | {
        kind: "answered";
        checkpointId: string;
        questionId: string;
        idempotencyKey: string;
        answer: string;
        effect: AnswerEffect;
      }
    | { kind: "claimed"; checkpointId: string }
    | { kind: "resuming"; checkpointId: string; newAttemptId: string; cwd: string }
    | { kind: "consumed"; checkpointId: string; newAttemptId: string }
    | { kind: "fence_bumped"; previousEpoch: number; newEpoch: number; reason: string }
    | { kind: "checkpoint_deferred"; checkpointId: string; reason: string }
    | { kind: "safe_section_enter"; sectionId: string }
    | { kind: "safe_section_exit"; sectionId: string }
    | { kind: "rejected_stale"; attemptedFenceEpoch: number; currentFenceEpoch: number; op: string }
    // --- M2: worktree allocator saga (intent -> act -> confirm, reconcile rolls back/finishes) ---
    | { kind: "worktree_intent"; allocationId: string; repoRoot: string; worktreePath: string; branch: string }
    | { kind: "worktree_allocated"; allocationId: string; baseSha: string; worktreePath: string; branch: string }
    | { kind: "worktree_confirmed"; allocationId: string }
    | { kind: "worktree_rollback"; allocationId: string; reason: string }
    // --- M2: plan pipeline (finding -> plan -> independent critique -> bounded debate) ---
    | { kind: "finding_recorded"; findingId: string; title: string; evidenceJson: string }
    | { kind: "plan_drafted"; planId: string; version: number; markdown: string; structuredJson: string }
    | {
        kind: "critique_independent";
        planId: string;
        round: number;
        /** Codex's own read of the finding + repo, formed BEFORE it sees Claude's plan. */
        assessmentJson: string;
      }
    | {
        kind: "critique_objections";
        planId: string;
        round: number;
        objectionsJson: string; // {"objections":[{severity,claim,suggested_change}]}
      }
    | { kind: "plan_revised"; planId: string; version: number; markdown: string; structuredJson: string; round: number }
    | { kind: "debate_capped"; planId: string; roundsRun: number; reason: string }
    | { kind: "plan_finalized"; planId: string; version: number; unresolvedObjectionsJson: string }
    // --- M3: Gate 1 (plan approval) ---
    | {
        /** A human (via dashboard or CLI) edited the plan document directly, WITHOUT restarting the run or touching the fence epoch or any attempt. This is the mechanism behind the M3 acceptance criterion "plan editing changes the document without restarting the run." */
        kind: "plan_edited";
        planId: string;
        version: number;
        markdown: string;
        editedBy: string; // e.g. "human" or a name/email; caller-supplied, not validated
        note?: string;
      }
    | {
        /** Corroborating evidence from the ExitPlanMode PostToolUse hook (ref.tools' mechanism). NEVER authoritative on its own -- see packages/mcp's exit-plan-mode-hook.ts. Recorded purely for audit/cross-check; a run's plan-approval state is determined ENTIRELY by checkpoint_requested/parked/answered entries, never by this. */
        kind: "hook_payload_received";
        hookName: string; // e.g. "PostToolUse:ExitPlanMode"
        sessionId: string | null;
        cwd: string | null;
        valid: boolean;
        reason: string | null; // why `valid` is false, if it is
        rawJsonExcerpt: string; // the raw payload (or as much as reasonably captured), truncated to a sane length (e.g. 20000 chars) so a huge plan doesn't bloat the journal disproportionately
      }
  );

export interface Manifest {
  runId: string;
  /** Recorded working directory to relaunch into. Disk is authoritative, not agent memory. */
  cwd: string;
  /** Canonical (symlink-resolved) form of `cwd` at snapshot time, so resume can detect the path being swapped for a different real directory. */
  cwdRealPath: string;
  headSha: string;
  baseSha: string;
  /** Hash covering staged, unstaged, AND untracked files -- plain `git diff` misses untracked. */
  workingStateHash: string;
  fenceEpoch: number;
  launchConfig: LaunchConfig;
  createdAt: string;
}

export interface LaunchConfig {
  provider: "claude" | "codex" | "fixture";
  command: string;
  args: string[];
  cwd: string;
  sessionId?: string;
  env?: Record<string, string>;
}
