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
}

export interface RunState {
  fenceEpoch: number;
  attempts: Map<string, AttemptRecord>;
  checkpoints: Map<string, CheckpointRecord>;
  /** idempotencyKey -> checkpointId, so a replayed ask_human call cannot mint a second question. */
  idempotencyIndex: Map<string, string>;
  lastSeq: number;
  truncated: boolean;
}

export function projectRunState(entries: JournalEntry[]): RunState {
  const state: RunState = {
    fenceEpoch: 0,
    attempts: new Map(),
    checkpoints: new Map(),
    idempotencyIndex: new Map(),
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
