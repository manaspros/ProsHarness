import { readdir } from "node:fs/promises";
import path from "node:path";
import { Barrier, loadRunState, type AnswerEffect } from "@pros/barrier";

export interface AnswerArgs {
  questionId: string;
  choice: string;
  effect: AnswerEffect;
  runsRoot: string;
}

export function parseAnswerArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): AnswerArgs {
  // pros answer <question-id> <choice> [--effect=continue_within_approved_plan|requires_plan_amendment|abort]
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [questionId, choice] = positional;
  if (!questionId || !choice) {
    throw new Error("usage: pros answer <question-id> <choice> [--effect=continue_within_approved_plan|requires_plan_amendment|abort]");
  }
  const effectArg = argv.find((a) => a.startsWith("--effect="))?.slice("--effect=".length);
  const effect: AnswerEffect = (effectArg as AnswerEffect | undefined) ?? "continue_within_approved_plan";
  if (!["continue_within_approved_plan", "requires_plan_amendment", "abort"].includes(effect)) {
    throw new Error(`invalid --effect: ${effect}`);
  }
  const runsRoot = env.PROS_RUNS_DIR ?? path.join(env.HOME ?? "/root", ".pros", "runs");
  return { questionId, choice, effect, runsRoot };
}

/**
 * Finds which run currently holds a parked checkpoint for the given
 * question id. Scanning is fine at single-user scale (docs/00-decisions.md
 * D1); there is no SQLite index to query yet in M1.
 */
export async function findRunForQuestion(
  runsRoot: string,
  questionId: string,
): Promise<{ runDir: string; runId: string; checkpointId: string } | undefined> {
  let runIds: string[];
  try {
    runIds = await readdir(runsRoot);
  } catch {
    return undefined;
  }
  for (const runId of runIds) {
    const runDir = path.join(runsRoot, runId);
    const state = await loadRunState(runDir).catch(() => undefined);
    if (!state) continue;
    for (const cp of state.checkpoints.values()) {
      if (cp.questionId === questionId && cp.phase === "parked") {
        return { runDir, runId, checkpointId: cp.checkpointId };
      }
    }
  }
  return undefined;
}

export async function runAnswerCommand(argv: string[]): Promise<string> {
  const args = parseAnswerArgs(argv);
  const found = await findRunForQuestion(args.runsRoot, args.questionId);
  if (!found) {
    throw new Error(
      `no parked question found with id ${args.questionId} under ${args.runsRoot} -- it may already be answered, or belong to a different runs root`,
    );
  }

  const barrier = await Barrier.open(found.runDir, found.runId);
  try {
    const cp = barrier.getState().checkpoints.get(found.checkpointId);
    if (!cp) throw new Error(`checkpoint ${found.checkpointId} vanished between lookup and open`);
    if (cp.gateType === "plan_approval" && args.effect === "requires_plan_amendment") {
      throw new Error("Gate 1 amendment is unavailable; approve or reject the current plan instead");
    }
    await barrier.recordAnswer(found.checkpointId, args.questionId, cp.idempotencyKey, args.choice, args.effect);
    return `answered ${args.questionId} (checkpoint ${found.checkpointId}) in run ${found.runId}: "${args.choice}" [${args.effect}]`;
  } finally {
    await barrier.close();
  }
}
