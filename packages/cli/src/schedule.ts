/**
 * `pros schedule` -- wires @pros/schedule's two real jobs (trigger-sweep,
 * skillrank-weekly) to the four @pros/triggers sources and starts/reports
 * the scheduler loop. Mirrors reconcile.ts's structure and this CLI's
 * established env-var-driven config resolution convention: `<HOME ??
 * "/root">/.pros/<name>` for every directory this command owns.
 *
 * `pros schedule start` runs the loop forever (until the process is
 * killed) -- this is meant to be run as a long-lived background process,
 * not a one-shot command. `pros schedule status` is the "observable"
 * counterpart: a human can check job health without the loop running in
 * the same process (it just reads the same durable status files off
 * disk).
 */
import path from "node:path";
import { GranolaSource, LinearSource, SlackSource, SweepSource } from "@pros/triggers";
import type { TriggerSource } from "@pros/triggers";
import { listJobStatuses, makeSkillrankWeeklyJob, makeTriggerSweepJob, startSchedulerLoop } from "@pros/schedule";

export interface ScheduleArgs {
  pollIntervalMs?: number;
}

export function parseScheduleStartArgs(argv: string[]): ScheduleArgs {
  // pros schedule start [--interval=<pollIntervalMs>]
  const intervalArg = argv.find((a) => a.startsWith("--interval="))?.slice("--interval=".length);
  return { pollIntervalMs: intervalArg ? Number(intervalArg) : undefined };
}

export interface ScheduleDirs {
  runsRoot: string;
  worktreesRoot: string;
  leaseDir: string;
  dedupDir: string;
  statusDir: string;
  lockFilePath: string;
  minerOutDir: string;
  skillrankOutDir: string;
}

function homeRoot(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? "/root";
}

export function resolveScheduleDirs(env: NodeJS.ProcessEnv = process.env): ScheduleDirs {
  const home = homeRoot(env);
  return {
    runsRoot: env.PROS_RUNS_DIR ?? path.join(home, ".pros", "runs"),
    worktreesRoot: env.PROS_WORKTREES_DIR ?? path.join(home, ".pros", "worktrees"),
    leaseDir: env.PROS_LEASE_DIR ?? path.join(home, ".pros", "leases"),
    dedupDir: env.PROS_DEDUP_DIR ?? path.join(home, ".pros", "dedup"),
    statusDir: env.PROS_SCHEDULE_STATUS_DIR ?? path.join(home, ".pros", "schedule"),
    lockFilePath: env.PROS_SKILL_LOCK_FILE ?? path.join(home, ".pros", "skill-registry-lock.json"),
    minerOutDir: env.PROS_MINER_OUT ?? path.join(home, ".pros", "miner"),
    skillrankOutDir: env.PROS_SKILLRANK_OUT ?? path.join(home, ".pros", "skillrank"),
  };
}

function buildSources(env: NodeJS.ProcessEnv, repoRoot: string): TriggerSource[] {
  return [
    new LinearSource({
      fixturePath: env.PROS_LINEAR_FIXTURE,
      apiUrl: env.PROS_LINEAR_API_URL,
      apiKey: env.PROS_LINEAR_API_KEY,
    }),
    new SlackSource({
      fixturePath: env.PROS_SLACK_FIXTURE,
      botToken: env.PROS_SLACK_BOT_TOKEN,
      channel: env.PROS_SLACK_CHANNEL,
    }),
    new GranolaSource({
      fixturePath: env.PROS_GRANOLA_FIXTURE,
      apiKey: env.PROS_GRANOLA_API_KEY,
    }),
    new SweepSource({ repoRoot }),
  ];
}

export function buildScheduledJobs(env: NodeJS.ProcessEnv = process.env) {
  const dirs = resolveScheduleDirs(env);
  const repoRoot = env.PROS_REPO_ROOT ?? process.cwd();
  const maxConcurrent = env.PROS_MAX_CONCURRENT ? Number(env.PROS_MAX_CONCURRENT) : 3;
  const maxTokensPerRun = env.PROS_MAX_TOKENS_PER_RUN ? Number(env.PROS_MAX_TOKENS_PER_RUN) : 200_000;

  const triggerSweepJob = makeTriggerSweepJob({
    sources: buildSources(env, repoRoot),
    dedupDir: dirs.dedupDir,
    leaseDir: dirs.leaseDir,
    maxConcurrent,
    repoRoot,
    worktreesRoot: dirs.worktreesRoot,
    runsRoot: dirs.runsRoot,
    maxTokensPerRun,
    ntfyUrl: env.PROS_NTFY_URL,
  });

  const skillrankJob = makeSkillrankWeeklyJob({
    lockFilePath: dirs.lockFilePath,
    minerOutDir: dirs.minerOutDir,
    outDir: dirs.skillrankOutDir,
  });

  return { jobs: [triggerSweepJob, skillrankJob], statusDir: dirs.statusDir };
}

export async function runScheduleStartCommand(argv: string[]): Promise<string> {
  const args = parseScheduleStartArgs(argv);
  const { jobs, statusDir } = buildScheduledJobs();
  startSchedulerLoop({ jobs, statusDir, pollIntervalMs: args.pollIntervalMs });
  return `scheduler loop started: jobs=${jobs.map((j) => j.name).join(", ")}, statusDir=${statusDir}${
    args.pollIntervalMs ? `, pollIntervalMs=${args.pollIntervalMs}` : ""
  }`;
}

function formatStatusLine(status: Awaited<ReturnType<typeof listJobStatuses>>[number]): string {
  const parts = [
    `${status.name}:`,
    `status=${status.lastStatus}`,
    `lastRunAt=${status.lastRunAt ?? "never"}`,
    `nextDueAt=${status.nextDueAt ?? "n/a"}`,
  ];
  if (status.lastStatus === "error" && status.lastError) {
    parts.push(`error="${status.lastError}"`);
  }
  return parts.join(" ");
}

export async function runScheduleStatusCommand(_argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dirs = resolveScheduleDirs(env);
  const statuses = await listJobStatuses(dirs.statusDir);
  if (statuses.length === 0) {
    return `no scheduled jobs have ever run yet (statusDir=${dirs.statusDir})`;
  }
  return statuses.map(formatStatusLine).join("\n");
}

export async function runScheduleCommand(argv: string[]): Promise<string> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "start":
      return runScheduleStartCommand(rest);
    case "status":
      return runScheduleStatusCommand(rest);
    default:
      throw new Error("usage: pros schedule <start|status> [--interval=<pollIntervalMs>]");
  }
}
