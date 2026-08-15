import { randomUUID } from "node:crypto";
import { open, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { Barrier, Journal, loadRunState } from "@pros/barrier";
import { wireNtfyNotifications } from "@pros/notify";
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
  /**
   * Passed straight through to `wireNtfyNotifications({ url })`. If
   * undefined, `sendNtfy` itself falls back to `process.env.PROS_NTFY_URL`
   * -- the fallback lives there, not here, so this stays a thin pass-through.
   */
  ntfyUrl?: string;
  /**
   * Passed straight through to `wireNtfyNotifications({ slackTarget })`.
   * Only relevant when `ntfyUrl`/PROS_NTFY_URL is NOT set -- in that case
   * the notifier falls back to a Slack DM via the connected Slack MCP
   * server, and this optionally redirects it to a specific channel/user
   * instead of the default "DM yourself". If undefined, the fallback reads
   * process.env.PROS_SLACK_NOTIFY_TARGET, mirroring ntfyUrl's own fallback.
   */
  slackTarget?: string;
  /** Retained for backwards-compatible callers; dashboard/CLI sessions always force this on. */
  dangerouslySkipPermissions?: boolean;
}

export interface PlanPipelineResult {
  runId: string;
  worktreePath: string;
  finding: Finding;
  debate: DebateResult;
  planMarkdownPath: string;
  objectionsJsonPath: string;
  /** The Gate 1 checkpoint id this run parked under -- see Barrier.parkForGate1. */
  checkpointId: string;
  /** The question id `pros answer <questionId> <choice> --effect=...` needs to resolve Gate 1. */
  questionId: string;
  /** True once parkForGate1 has durably recorded `parked` for this run. */
  parked: boolean;
}

/** Atomic temp-write + rename + fsync(file) + fsync(dir) -- same durability discipline as barrier's manifest.ts / worktree's allocator.ts. Exported so gate1.ts (plan editing, M3) can reuse it rather than duplicate it. */
export async function writeFileAtomic(finalPath: string, body: string): Promise<void> {
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
  // The operator has explicitly chosen an always-on Claude Code workflow.
  // Normalize here so every entry point (dashboard, CLI, and triggers) gets
  // the same behavior, even if an older caller omits the option.
  const dangerouslySkipPermissions = true;
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
    dangerouslySkipPermissions,
    rawLogPath: path.join(runDir, "attempts", `${runId}-finding`, "raw.log"),
    attemptId: `${runId}-finding`,
  });
  await journal.append({
    runId,
    fenceEpoch,
    kind: "finding_recorded",
    findingId: finding.findingId,
    title: finding.title,
    evidenceJson: JSON.stringify(finding.evidence),
    summary: finding.summary,
  });
  if (finding.sessionId) {
    await journal.append({
      runId,
      fenceEpoch,
      kind: "model_session_recorded",
      provider: "claude",
      sessionId: finding.sessionId,
      attemptId: `${runId}-finding`,
      dangerouslySkipPermissions,
    });
  }

  const debate = await runDebate({
    claudeSession,
    codexSession,
    cwd: allocation.path,
    finding,
    journal,
    runId,
    runDir,
    attemptIdPrefix: runId,
    dangerouslySkipPermissions,
    rawLogPathForAttempt: (attemptId) => path.join(runDir, "attempts", attemptId, "raw.log"),
  });

  if (debate.finalPlan.sessionId) {
    await journal.append({
      runId,
      fenceEpoch,
      kind: "model_session_recorded",
      provider: "claude",
      sessionId: debate.finalPlan.sessionId,
      attemptId: `${runId}-plan-v${debate.finalPlan.version}`,
      dangerouslySkipPermissions,
    });
  }

  const planMarkdownPath = path.join(runDir, "plan.md");
  const objectionsJsonPath = path.join(runDir, "objections.json");
  await writeFileAtomic(planMarkdownPath, debate.finalPlan.markdown);
  await writeFileAtomic(
    objectionsJsonPath,
    JSON.stringify({ objections: debate.allObjections, unresolved: debate.unresolvedObjections }, null, 2),
  );

  // Gate 1: park the run for human plan approval now that plan_finalized has
  // landed. No live attempt/guardian exists at this point (finding/debate
  // were one-shot ModelSession.run() calls) -- see Barrier.parkForGate1's
  // doc comment for why this is the additive, guardian-quiesce-skipping
  // parking path rather than the ask_human/requestCheckpoint one.
  //
  // idempotencyKey is deliberately deterministic (runId + plan version, not
  // randomUUID()) so that a crash-and-retry of the WHOLE pipeline for the
  // same run/version can never mint a second Gate 1 checkpoint --
  // parkForGate1's own idempotencyIndex lookup then makes a replay a no-op
  // that returns the original checkpointId.
  const barrier = await Barrier.open(runDir, runId);
  let checkpointId: string;
  let questionId: string;
  try {
    // Fire-and-forget notification wiring: onParked's listener is a detached
    // microtask (see Barrier.fireParked), so a hung/unreachable ntfy target
    // can never delay or block parkForGate1 below -- proven in
    // packages/notify/test/barrier-integration.test.ts and re-proven against
    // the real pipeline in gate1-e2e.test.ts.
    const unsubscribe = wireNtfyNotifications(barrier, { url: opts.ntfyUrl, slackTarget: opts.slackTarget });
    try {
      const unresolvedCount = debate.unresolvedObjections.length;
      const totalCount = debate.allObjections.length;
      const freshQuestionId = randomUUID();
      const idempotencyKey = `gate1-${runId}-v${debate.finalPlan.version}`;
      const result = await barrier.parkForGate1({
        cwd: allocation.path,
        prompt: `Plan for run ${runId}: ${finding.title}. ${totalCount} objections (${unresolvedCount} unresolved).`,
        options: ["approve", "amend", "reject"],
        questionId: freshQuestionId,
        idempotencyKey,
        planRef: { planId: debate.finalPlan.planId, version: debate.finalPlan.version },
      });
      checkpointId = result.checkpointId;
      // On a fresh park this IS freshQuestionId; on a replayed/idempotent
      // call (same idempotencyKey already recorded) parkForGate1 returns the
      // ORIGINAL checkpointId, whose questionId is whatever was minted the
      // first time -- never the one just generated here. Read it back from
      // state rather than assuming freshQuestionId, so a retried pipeline
      // call always reports the question id that is actually resolvable via
      // `pros answer`.
      questionId = barrier.getState().checkpoints.get(checkpointId)?.questionId ?? freshQuestionId;
    } finally {
      unsubscribe();
    }
  } finally {
    await barrier.close();
  }

  return {
    runId,
    worktreePath: allocation.path,
    finding,
    debate,
    planMarkdownPath,
    objectionsJsonPath,
    checkpointId,
    questionId,
    parked: true,
  };
}
