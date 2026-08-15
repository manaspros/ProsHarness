/**
 * "List every run under PROS_RUNS_DIR" -- the exact scan pattern
 * packages/cli/src/answer.ts's `findRunForQuestion` uses (readdir the runs
 * root, loadRunState per entry), generalized to return every run instead of
 * searching for one matching question. There is no existing `listRuns`
 * helper anywhere in the repo (per the brief), so this is new, but it
 * intentionally mirrors findRunForQuestion's defensiveness: a run directory
 * can be mid-write or otherwise unreadable (e.g. another process holds the
 * journal lock, or the directory was only just mkdir'd and has no journal
 * yet) -- skip it rather than let one bad run 500 the whole /runs page.
 */
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { loadRunState, readManifest, type RunState, type Manifest } from "@pros/barrier";

export interface RunSummary {
  runId: string;
  runDir: string;
  state: RunState;
  manifest: Manifest | undefined;
}

export async function listRuns(runsRoot: string): Promise<RunSummary[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    // Runs root doesn't exist yet (fresh install) -- render "no runs yet",
    // not a crash.
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const runId = ent.name;
    const runDir = path.join(runsRoot, runId);
    const state = await loadRunState(runDir).catch(() => undefined);
    if (!state) continue; // unreadable/mid-write run dir -- skip, don't crash the page
    const manifest = await readManifest(runDir).catch(() => undefined);
    summaries.push({ runId, runDir, state, manifest });
  }
  // Stable, readable ordering for the list page.
  summaries.sort((a, b) => a.runId.localeCompare(b.runId));
  return summaries;
}
