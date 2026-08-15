#!/usr/bin/env tsx
/**
 * scripts/seed-reset.ts -- undoes exactly what scripts/seed-demo.ts created,
 * and nothing else.
 *
 * Only ever deletes:
 *   1. Run directories under PROS_RUNS_DIR whose id starts with "demo-"
 *      (never a blanket wipe of the whole runs dir).
 *   2. Worktree directories that a demo run's own journal
 *      (`worktree_allocated` entries) actually references, AND that resolve
 *      to a path physically under PROS_WORKTREES_DIR -- traced back to a
 *      demo-* run, never guessed.
 *   3. The demo repo + its bare origin at PROS_DEMO_REPO_ROOT /
 *      PROS_DEMO_REPO_ROOT-origin.git.
 *   4. PROS_INDEX_DB (+ -wal/-shm) -- always safe, it's a rebuildable cache.
 *
 * Refuses (prints an error, exits nonzero) rather than guessing if it finds
 * anything under the runs dir that looks demo-ish but doesn't cleanly match
 * the "demo-" prefix this project's own seed script uses.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Journal } from "@pros/barrier";

const HOME = os.homedir();
const RUNS_DIR = process.env.PROS_RUNS_DIR ?? path.join(HOME, ".pros", "runs");
const WORKTREES_DIR = process.env.PROS_WORKTREES_DIR ?? path.join(HOME, ".pros", "worktrees");
const INDEX_DB = process.env.PROS_INDEX_DB ?? path.join(HOME, ".pros", "index.sqlite");
const DEMO_REPO_ROOT = process.env.PROS_DEMO_REPO_ROOT ?? path.join(HOME, ".pros", "demo-repo");
const DEMO_REPO_ORIGIN = `${DEMO_REPO_ROOT}-origin.git`;

const DEMO_PREFIX = "demo-";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let runNames: string[] = [];
  try {
    runNames = (await readdir(RUNS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  const demoRunNames = runNames.filter((n) => n.startsWith(DEMO_PREFIX));
  // Defensive refusal: anything that LOOKS demo-related ("demo", "Demo",
  // "DEMO-x") but doesn't match the exact prefix our own seed script uses is
  // NOT something this script is confident enough to touch.
  const suspiciousLookAlikes = runNames.filter(
    (n) => n.toLowerCase().startsWith("demo") && !n.startsWith(DEMO_PREFIX),
  );
  if (suspiciousLookAlikes.length > 0) {
    console.error(
      `seed-reset: refusing to proceed -- found run dir(s) under ${RUNS_DIR} that look demo-related but don't match the exact "${DEMO_PREFIX}" prefix seed-demo.ts uses: ${suspiciousLookAlikes.join(", ")}. Not confident these are safe to delete; investigate and rename/remove manually.`,
    );
    process.exit(1);
  }

  const removedRuns: string[] = [];
  const removedWorktrees: string[] = [];
  const resolvedWorktreesRoot = path.resolve(WORKTREES_DIR);

  for (const runId of demoRunNames) {
    const runDir = path.join(RUNS_DIR, runId);

    if (await Journal.exists(runDir)) {
      const { entries } = await Journal.read(runDir);
      const raw = entries as unknown as Array<Record<string, unknown>>;
      const worktreePaths = new Set<string>();
      for (const e of raw) {
        if (e.kind === "worktree_allocated" && typeof e.worktreePath === "string") {
          worktreePaths.add(e.worktreePath);
        }
      }
      for (const wt of worktreePaths) {
        const resolvedWt = path.resolve(wt);
        // Only remove a worktree path that is genuinely nested under
        // PROS_WORKTREES_DIR -- traced back to THIS demo run's own journal,
        // never a blanket sweep of the worktrees dir.
        const isUnderWorktreesRoot =
          resolvedWt === resolvedWorktreesRoot || resolvedWt.startsWith(resolvedWorktreesRoot + path.sep);
        if (isUnderWorktreesRoot && (await pathExists(wt))) {
          await rm(wt, { recursive: true, force: true });
          removedWorktrees.push(wt);
        }
      }
    }

    await rm(runDir, { recursive: true, force: true });
    removedRuns.push(runId);
  }

  const removedOther: string[] = [];
  if (await pathExists(DEMO_REPO_ROOT)) {
    await rm(DEMO_REPO_ROOT, { recursive: true, force: true });
    removedOther.push(DEMO_REPO_ROOT);
  }
  if (await pathExists(DEMO_REPO_ORIGIN)) {
    await rm(DEMO_REPO_ORIGIN, { recursive: true, force: true });
    removedOther.push(DEMO_REPO_ORIGIN);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = INDEX_DB + suffix;
    if (await pathExists(p)) {
      await rm(p, { force: true });
      removedOther.push(p);
    }
  }

  console.log("seed-reset: done. Removed:");
  console.log(`  run dirs (${removedRuns.length}): ${removedRuns.length ? removedRuns.join(", ") : "(none found)"}`);
  console.log(`  worktree dirs (${removedWorktrees.length}): ${removedWorktrees.length ? removedWorktrees.join(", ") : "(none found)"}`);
  console.log(`  other (${removedOther.length}): ${removedOther.length ? removedOther.join(", ") : "(none found)"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
