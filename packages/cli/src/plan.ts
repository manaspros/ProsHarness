import path from "node:path";
import { runPlanPipeline, type PlanPipelineOptions, type PlanPipelineResult } from "@pros/plan";

export interface PlanArgs {
  repoRoot: string;
  description: string;
  runId?: string;
}

export function parsePlanArgs(argv: string[]): PlanArgs {
  // pros plan <repoRoot> "<description>" [--run-id=<id>]
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [repoRoot, description] = positional;
  if (!repoRoot || !description) {
    throw new Error('usage: pros plan <repoRoot> "<description>" [--run-id=<id>]');
  }
  const runId = argv.find((a) => a.startsWith("--run-id="))?.slice("--run-id=".length);
  return { repoRoot: path.resolve(repoRoot), description, runId };
}

function objectionsSummary(result: PlanPipelineResult): string {
  const counts = { blocker: 0, major: 0, minor: 0 };
  let accepted = 0;
  let unresolved = 0;
  for (const o of result.debate.allObjections) {
    counts[o.severity] += 1;
    if (o.resolution === "accepted") accepted += 1;
    else unresolved += 1;
  }
  return (
    `objections: ${result.debate.allObjections.length} total ` +
    `(blocker=${counts.blocker}, major=${counts.major}, minor=${counts.minor}); ` +
    `${accepted} accepted, ${unresolved} unresolved` +
    (result.debate.cappedReason ? ` [debate stopped early: ${result.debate.cappedReason}]` : "")
  );
}

export async function runPlanCommand(argv: string[], envOverrides: Partial<PlanPipelineOptions> = {}): Promise<string> {
  const args = parsePlanArgs(argv);
  const env = process.env;
  const worktreesRoot = envOverrides.worktreesRoot ?? env.PROS_WORKTREES_DIR ?? path.join(env.HOME ?? "/root", ".pros", "worktrees");
  const runsRoot = envOverrides.runsRoot ?? env.PROS_RUNS_DIR ?? path.join(env.HOME ?? "/root", ".pros", "runs");

  const result = await runPlanPipeline({
    repoRoot: args.repoRoot,
    worktreesRoot,
    runsRoot,
    description: args.description,
    runId: args.runId,
    ...envOverrides,
  });

  return [
    `plan written: ${result.planMarkdownPath}`,
    `objections written: ${result.objectionsJsonPath}`,
    objectionsSummary(result),
    `checkpoint: ${result.checkpointId}`,
    `awaiting Gate 1 approval -- run: pros answer ${result.questionId} <approve|amend|reject> --effect=<continue_within_approved_plan|requires_plan_amendment|abort>`,
  ].join("\n");
}
