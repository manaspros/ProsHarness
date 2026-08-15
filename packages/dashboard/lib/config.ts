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

export function getRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_RUNS_DIR ?? path.join(env.HOME ?? "/root", ".pros", "runs");
}

export function getIndexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROS_INDEX_DB ?? path.join(env.HOME ?? "/root", ".pros", "index.sqlite");
}
