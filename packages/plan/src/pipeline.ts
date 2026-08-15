import { randomUUID } from "node:crypto";
import { open, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { WorktreeAllocator } from "@pros/worktree";
import type { ModelSession } from "./model-session.js";
import { RealClaudeSession, RealCodexSession } from "./real-sessions.js";
import { runFinding, type Finding } from "./finding.js";
import { runDebate, type DebateResult } from "./debate.js";

export interface PlanPipelineOptions {
  repoRoot: string;
  worktreesRoot: string;
  runsRoot: string;
  /** The bug/task description driving the finding. */
  description: string;
  runId?: string;
  claudeSession?: ModelSession;
  codexSession?: ModelSession;
}

export interface PlanPipelineResult {
  runId: string;
  worktreePath: string;
  finding: Finding;
  debate: DebateResult;
  planMarkdownPath: string;
  objectionsJsonPath: string;
}

/** Atomic temp-write + rename + fsync(file) + fsync(dir) -- same durability discipline as barrier's manifest.ts / worktree's allocator.ts. */
async function writeFileAtomic(finalPath: string, body: string): Promise<void> {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}`);
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, finalPath);
  await Journal.fsyncDir(dir);
}

/**
 * Ties the plan pipeline together: allocate the worktree FIRST (atomically,
 * before any agent runs -- the explicit M2 requirement, docs/03-architecture.md),
 * then run finding + debate INSIDE that worktree, then durably persist the
 * final plan + objections to disk.
 */
export async function runPlanPipeline(opts: PlanPipelineOptions): Promise<PlanPipelineResult> {
  const runId = opts.runId ?? randomUUID();
  const runDir = path.join(opts.runsRoot, runId);
  await mkdir(runDir, { recursive: true });

  const allocator = new WorktreeAllocator({
    repoRoot: opts.repoRoot,
    worktreesRoot: opts.worktreesRoot,
    runsRoot: opts.runsRoot,
  });
  const allocation = await allocator.allocate(runId);

  const journal = await Journal.open(runDir);
  const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;

  const claudeSession = opts.claudeSession ?? new RealClaudeSession();
  const codexSession = opts.codexSession ?? new RealCodexSession();

  const finding = await runFinding(claudeSession, {
    cwd: allocation.path,
    description: opts.description,
    attemptId: `${runId}-finding`,
  });
  await journal.append({
    runId,
    fenceEpoch,
    kind: "finding_recorded",
    findingId: finding.findingId,
    title: finding.title,
    evidenceJson: JSON.stringify(finding.evidence),
  });

  const debate = await runDebate({
    claudeSession,
    codexSession,
    cwd: allocation.path,
    finding,
    journal,
    runId,
    runDir,
    attemptIdPrefix: runId,
  });

  const planMarkdownPath = path.join(runDir, "plan.md");
  const objectionsJsonPath = path.join(runDir, "objections.json");
  await writeFileAtomic(planMarkdownPath, debate.finalPlan.markdown);
  await writeFileAtomic(
    objectionsJsonPath,
    JSON.stringify({ objections: debate.allObjections, unresolved: debate.unresolvedObjections }, null, 2),
  );

  return {
    runId,
    worktreePath: allocation.path,
    finding,
    debate,
    planMarkdownPath,
    objectionsJsonPath,
  };
}
