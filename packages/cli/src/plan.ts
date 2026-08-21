import path from "node:path";
import { runPlanPipeline, type PlanPipelineOptions, type PlanPipelineResult } from "@pros/plan";
import { requireProjectByName, hasTicketReference, notificationsEnabledFromEnv, type ProjectConfig } from "@pros/implement";

export interface PlanArgs {
  repoRoot: string;
  description: string;
  runId?: string;
  /** Set only when resolved via `--project=<name>`; undefined for the legacy bare-repoRoot path. */
  project?: ProjectConfig;
}

export function parsePlanArgs(argv: string[]): PlanArgs {
  // pros plan <repoRoot> "<description>" [--run-id=<id>]
  // pros plan --project=<name> "<description>" [--run-id=<id>]
  const positional = argv.filter((a) => !a.startsWith("--"));
  const runId = argv.find((a) => a.startsWith("--run-id="))?.slice("--run-id=".length);
  const projectName = argv.find((a) => a.startsWith("--project="))?.slice("--project=".length);

  if (projectName) {
    // Named-project mode: repoRoot comes from the registry, never a positional.
    // Unknown project names fail loudly via requireProjectByName -- the
    // allowlist is a feature, not an obstacle.
    const [description] = positional;
    if (!description) {
      throw new Error('usage: pros plan --project=<name> "<description>" [--run-id=<id>]');
    }
    const project = requireProjectByName(projectName);
    return { repoRoot: project.repoRoot, description, runId, project };
  }

  // Legacy path: bare repoRoot, no allowlist, unchanged behavior for any
  // existing caller (CLI or library) that doesn't know about named projects.
  const [repoRoot, description] = positional;
  if (!repoRoot || !description) {
    throw new Error(
      'usage: pros plan <repoRoot> "<description>" [--run-id=<id>]  (or: pros plan --project=<name> "<description>")',
    );
  }
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

  // Mined rule 1 ("never begin implementation without a ticket reference"):
  // only enforced in named-project mode, since the legacy bare-repoRoot path
  // has no project to carry a ticketPattern and must stay unchanged.
  if (args.project && !hasTicketReference(args.project, args.description)) {
    throw new Error(
      `pros plan --project=${args.project.name}: description must contain a ticket reference matching ` +
        `${args.project.ticketPattern} (e.g. "AGENT-1234: fix the thing"), got: ${JSON.stringify(args.description)}`,
    );
  }

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
    // B8: was hardcoded `?? false` with no flag anywhere to flip it. Now
    // defers to PROS_NOTIFICATIONS_ENABLED (see @pros/notify's
    // notificationsEnabledFromEnv) unless a caller (e.g. a test, or a
    // library caller that wants a fixed policy) passes an explicit value.
    notificationsEnabled: envOverrides.notificationsEnabled ?? notificationsEnabledFromEnv(env),
  });

  return [
    `plan written: ${result.planMarkdownPath}`,
    `objections written: ${result.objectionsJsonPath}`,
    objectionsSummary(result),
    `checkpoint: ${result.checkpointId}`,
    `awaiting Gate 1 approval -- run: pros answer ${result.questionId} <approve|amend|reject> --effect=<continue_within_approved_plan|requires_plan_amendment|abort>`,
  ].join("\n");
}
