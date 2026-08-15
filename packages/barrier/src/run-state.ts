import type { JournalEntry, RunPhase } from "./types.js";
import { Journal } from "./journal.js";

/**
 * The in-memory projection rebuilt by replaying the journal. This is the M1
 * stand-in for "SQLite is a rebuildable index over the journal" -- there is
 * no SQLite yet, but the rule already holds: nothing here is authoritative,
 * it is all derivable by replaying journal.ndjson from byte zero.
 */
export interface AttemptRecord {
  attemptId: string;
  cwd: string;
  launchConfigHash: string;
  unitName: string;
  phase: RunPhase;
  fenceEpochAtStart: number;
  endedReason?: string;
}

export interface CheckpointRecord {
  checkpointId: string;
  attemptId: string;
  questionId: string;
  idempotencyKey: string;
  prompt: string;
  options: string[];
  phase: RunPhase;
  answer?: string;
  effect?: string;
  manifestPath?: string;
  /** Which human gate this is. Defaults to "ask_human" for entries written before this field existed. */
  gateType?: "ask_human" | "plan_approval" | "pr_review";
  /** Present only when gateType is "plan_approval". */
  planRef?: { planId: string; version: number };
  /** Present only when gateType is "pr_review" (M4 Gate 2). */
  prRef?: { url: string; number: number; headSha: string };
}

export interface RunState {
  fenceEpoch: number;
  attempts: Map<string, AttemptRecord>;
  checkpoints: Map<string, CheckpointRecord>;
  /** idempotencyKey -> checkpointId, so a replayed ask_human call cannot mint a second question. */
  idempotencyIndex: Map<string, string>;
  /** Corroborating (never authoritative) evidence from hook payloads received for this run -- see packages/mcp/src/exit-plan-mode-hook.ts. Appended to, never keyed/deduped. */
  hookPayloads: Array<{ hookName: string; sessionId: string | null; cwd: string | null; valid: boolean; reason: string | null; seq: number }>;
  lastSeq: number;
  truncated: boolean;
}

export function projectRunState(entries: JournalEntry[]): RunState {
  const state: RunState = {
    fenceEpoch: 0,
    attempts: new Map(),
    checkpoints: new Map(),
    idempotencyIndex: new Map(),
    hookPayloads: [],
    lastSeq: -1,
    truncated: false,
  };

  for (const e of entries) {
    state.lastSeq = e.seq;
    state.fenceEpoch = Math.max(state.fenceEpoch, e.fenceEpoch);

    switch (e.kind) {
      case "attempt_started":
        state.attempts.set(e.attemptId, {
          attemptId: e.attemptId,
          cwd: e.cwd,
          launchConfigHash: e.launchConfigHash,
          unitName: e.unitName,
          phase: "running",
          fenceEpochAtStart: e.fenceEpoch,
        });
        break;
      case "attempt_ended": {
        const a = state.attempts.get(e.attemptId);
        if (a) {
          a.endedReason = e.exitReason;
        }
        break;
      }
      case "checkpoint_requested": {
        if (!state.idempotencyIndex.has(e.idempotencyKey)) {
          state.idempotencyIndex.set(e.idempotencyKey, e.checkpointId);
          state.checkpoints.set(e.checkpointId, {
            checkpointId: e.checkpointId,
            attemptId: e.attemptId,
            questionId: e.questionId,
            idempotencyKey: e.idempotencyKey,
            prompt: e.prompt,
            options: e.options,
            phase: "checkpoint_requested",
            // Default to "ask_human" for backward compatibility with journal
            // entries written before gateType existed.
            gateType: e.gateType ?? "ask_human",
            planRef: e.planRef,
            prRef: e.prRef,
          });
        }
        break;
      }
      case "quiescing": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp) cp.phase = "quiescing";
        break;
      }
      case "parked": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp) {
          cp.phase = "parked";
          cp.manifestPath = e.manifestPath;
        }
        break;
      }
      case "answered": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp && cp.phase !== "consumed") {
          // First conditional update wins; later concurrent answers are audit-only.
          if (cp.answer === undefined) {
            cp.answer = e.answer;
            cp.effect = e.effect;
            cp.phase = "answered";
          }
        }
        break;
      }
      case "claimed": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp) cp.phase = "claimed";
        break;
      }
      case "resuming": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp) cp.phase = "resuming";
        break;
      }
      case "consumed": {
        const cp = state.checkpoints.get(e.checkpointId);
        if (cp) cp.phase = "consumed";
        break;
      }
      case "fence_bumped":
        state.fenceEpoch = e.newEpoch;
        break;
      case "plan_edited":
        // Does not affect attempts/checkpoints/fence -- the plan document's
        // own content lives on disk (plan.md) and, at the index-package
        // layer, in the `plans` table. Handled explicitly here (rather than
        // falling into `default`) so the intent is unambiguous to a future
        // reader: this entry kind is real and recognized, it's just a no-op
        // for RunState specifically.
        break;
      case "hook_payload_received":
        state.hookPayloads.push({
          hookName: e.hookName,
          sessionId: e.sessionId,
          cwd: e.cwd,
          valid: e.valid,
          reason: e.reason,
          seq: e.seq,
        });
        break;
      default:
        break;
    }
  }

  return state;
}

export async function loadRunState(runDir: string): Promise<RunState> {
  const { entries, truncated } = await Journal.read(runDir);
  const state = projectRunState(entries);
  state.truncated = truncated;
  return state;
}
