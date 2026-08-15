/**
 * Env-var configuration for the dashboard. Matches, byte for byte, the
 * defaulting convention already established in packages/cli/src/plan.ts and
 * packages/cli/src/answer.ts: `PROS_RUNS_DIR` env var, falling back to
 * `<HOME>/.pros/runs` (with HOME itself falling back to "/root", exactly as
 * those two files do -- do not "improve" this to os.homedir(), match the
 * existing convention exactly so a dashboard run against the same machine
 * looks at the same directory a `pros` CLI invocation would).
 *
 * `PROS_INDEX_DB` is new (this package introduces it): where the rebuildable
 * SQLite index gets written. Defaults to `<HOME>/.pros/index.sqlite`,
 * following the same `<HOME>/.pros/*` convention as runs/worktrees.
 */
import path from "node:path";

/**
 * The dashboard is normally started from either the repository root or
 * packages/dashboard (depending on whether pnpm is invoked through a root
 * script or a package script). Keep the default target repo useful in both
 * cases, while allowing an explicit PROS_REPO_ROOT to win.
 */
export function getDefaultRepoRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.PROS_REPO_ROOT) return path.resolve(env.PROS_REPO_ROOT);
  if (path.basename(cwd) === "dashboard" && path.basename(path.dirname(cwd)) === "packages") {
    return path.resolve(cwd, "../..");
  }
  return path.resolve(cwd);
}

/** ProsHarness's own checkout, used for loading its finder/implementer briefs. */
export function getHarnessRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.PROS_HARNESS_ROOT) return path.resolve(env.PROS_HARNESS_ROOT);
  if (path.basename(cwd) === "dashboard" && path.basename(path.dirname(cwd)) === "packages") {
    return path.resolve(cwd, "../..");
  }
  return path.resolve(cwd);
}

export function getWorktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_WORKTREES_DIR ?? path.join(env.HOME ?? "/root", ".pros", "worktrees");
}

export function getLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_LEASE_DIR ?? path.join(env.HOME ?? "/root", ".pros", "leases");
}

export function getMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  return env.PROS_MAX_CONCURRENT ? Number(env.PROS_MAX_CONCURRENT) : 3;
}

export function getMaxTokensPerRun(env: NodeJS.ProcessEnv = process.env): number {
  return env.PROS_MAX_TOKENS_PER_RUN ? Number(env.PROS_MAX_TOKENS_PER_RUN) : 200_000;
}

export function getRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_RUNS_DIR ?? path.join(env.HOME ?? "/root", ".pros", "runs");
}

export function getIndexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_INDEX_DB ?? path.join(env.HOME ?? "/root", ".pros", "index.sqlite");
}
