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
