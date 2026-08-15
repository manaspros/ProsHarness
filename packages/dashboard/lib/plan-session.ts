import { readFile } from "node:fs/promises";
import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { writeFileAtomic } from "@pros/plan";
import type { Finding, PlanDoc } from "@pros/plan";

export interface PlanRunContext {
  runDir: string;
  worktreePath: string;
  finding: Finding;
  currentPlan: PlanDoc;
  claudeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  existingObjectionsJson: string;
}

/** Load the durable hand-off needed by dashboard plan operations. */
export async function loadPlanRunContext(runsRoot: string, runId: string): Promise<PlanRunContext> {
  const runDir = path.join(runsRoot, runId);
  const { entries } = await Journal.read(runDir);
  const raw = entries as unknown as Array<Record<string, unknown>>;

  const findingEntry = [...raw].reverse().find((entry) => entry.kind === "finding_recorded") as
    | { findingId: string; title: string; summary?: string; evidenceJson: string }
    | undefined;
  if (!findingEntry) throw new Error(`no finding recorded for run ${runId}`);

  let evidence: Finding["evidence"] = [];
  try {
    const parsed = JSON.parse(findingEntry.evidenceJson);
    if (Array.isArray(parsed)) evidence = parsed as Finding["evidence"];
  } catch {
    // Keep the operation usable for old runs with malformed/absent evidence;
    // the original title and summary remain durable context.
  }

  const planEntries = raw.filter(
    (entry) => entry.kind === "plan_drafted" || entry.kind === "plan_revised" || entry.kind === "plan_edited",
  ) as Array<{ kind: string; planId: string; version: number; markdown: string; structuredJson?: string }>;
  const latestPlanEntry = [...planEntries].sort((a, b) => a.version - b.version).at(-1);
  if (!latestPlanEntry) throw new Error(`no plan recorded for run ${runId}`);

  const structuredEntry = [...planEntries]
    .reverse()
    .find((entry) => entry.planId === latestPlanEntry.planId && entry.version === latestPlanEntry.version && entry.structuredJson);
  let structured: unknown = { steps: [], filesTouched: [], risk: "unknown" };
  if (structuredEntry?.structuredJson) {
    try {
      structured = JSON.parse(structuredEntry.structuredJson);
    } catch {
      // Keep the shape accepted by the plan APIs.
    }
  }

  const allocated = [...raw].reverse().find((entry) => entry.kind === "worktree_allocated") as
    | { worktreePath: string }
    | undefined;
  if (!allocated?.worktreePath) throw new Error(`no worktree recorded for run ${runId}`);

  const sessionEntry = [...raw].reverse().find((entry) => entry.kind === "model_session_recorded" && entry.provider === "claude") as
    | { sessionId: string; dangerouslySkipPermissions?: boolean }
    | undefined;

  return {
    runDir,
    worktreePath: allocated.worktreePath,
    finding: {
      findingId: findingEntry.findingId,
      title: findingEntry.title,
      summary: findingEntry.summary ?? findingEntry.title,
      evidence,
    },
    currentPlan: {
      planId: latestPlanEntry.planId,
      version: latestPlanEntry.version,
      markdown: await readFile(path.join(runDir, "plan.md"), "utf8"),
      structured,
    },
    claudeSessionId: sessionEntry?.sessionId,
    // All current and resumed dashboard planning sessions use the same
    // always-on Claude Code permission-bypass workflow. This also upgrades
    // older runs whose journal predates the setting.
    dangerouslySkipPermissions: true,
    existingObjectionsJson: await readFile(path.join(runDir, "objections.json"), "utf8").catch(() => JSON.stringify({ objections: [], unresolved: [] })),
  };
}

export async function persistPlanVersion(opts: {
  runId: string;
  context: PlanRunContext;
  plan: PlanDoc;
  objectionsJson?: string;
  round: number;
  attemptId: string;
}): Promise<void> {
  const objectionsJson = opts.objectionsJson ?? opts.context.existingObjectionsJson;
  await writeFileAtomic(path.join(opts.context.runDir, "plan.md"), opts.plan.markdown);
  await writeFileAtomic(path.join(opts.context.runDir, "objections.json"), objectionsJson);

  const journal = await Journal.open(opts.context.runDir);
  try {
    const state = await loadRunState(opts.context.runDir);
    const fenceEpoch = state.fenceEpoch;
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "plan_revised",
      planId: opts.plan.planId,
      version: opts.plan.version,
      markdown: opts.plan.markdown,
      structuredJson: JSON.stringify(opts.plan.structured),
      round: opts.round,
    });
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "plan_finalized",
      planId: opts.plan.planId,
      version: opts.plan.version,
      unresolvedObjectionsJson: unresolvedObjectionsJson(objectionsJson),
    });
    if (opts.plan.sessionId) {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "model_session_recorded",
        provider: "claude",
        sessionId: opts.plan.sessionId,
        attemptId: opts.attemptId,
        dangerouslySkipPermissions: opts.context.dangerouslySkipPermissions,
      });
    }
  } finally {
    await journal.close();
  }
}

function unresolvedObjectionsJson(objectionsJson: string): string {
  try {
    const parsed = JSON.parse(objectionsJson) as { unresolved?: unknown };
    return JSON.stringify(parsed.unresolved ?? []);
  } catch {
    return "[]";
  }
}
