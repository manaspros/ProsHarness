import path from "node:path";
import Link from "next/link";
import { ArrowUpRight, CircleAlert, Layers3, Plus, RotateCcw } from "lucide-react";

import { getDefaultRepoRoot, getRunsRoot, getIndexDbPath } from "@/lib/config";
import { listRuns } from "@/lib/list-runs";
import { rebuildAndOpenIndex } from "@/lib/db";
import { rebuildHealthIssues, isHealthy } from "@/lib/health";
import { parseLatestEventOfKind, type VerifyVerdictPayload, type ReviewCompletedPayload, type PrCreatedPayload } from "@/lib/review-data";
import { findRunningAttemptId, deriveLiveness } from "@/lib/run-status";
import { getRawLogMtimeMs } from "@/lib/liveness-io";
import {
  deriveBoardStage,
  unresolvedObjections,
  hasMajorUnresolved,
  getLastEventTimestamp,
  formatRelativeTime,
  resolveCurrentPlan,
  BOARD_STAGES,
  STAGE_LABELS,
  type BoardStage,
} from "@/lib/board-data";
import { getPlans, getObjections } from "@pros/index";
import { EmptyState } from "@/components/EmptyState";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { BoardClient, type BoardColumn } from "@/components/board/BoardClient";
import { WorkspaceClient } from "@/components/WorkspaceClient";
import type { Status } from "@/components/StatusPill";
import type { BoardCardData } from "@/components/board/BoardCard";

export const dynamic = "force-dynamic"; // never cache a runs board relative to the on-disk journal, same as /runs

// This stage->StatusPill mapping is board-only presentation and
// deliberately coarser than BoardStage itself (StatusPill's palette is
// fixed to parked/running/done/idle/pass/fail/blocked -- see
// components/StatusPill.tsx): "finding" reads as idle (no plan work
// visible yet), "planning"/"implementing"/"verifying" all read as active
// pipeline work ("running"), the two gate-parked stages read as "parked",
// and "shipped" reads as "done".
const STAGE_PILL_STATUS: Record<BoardStage, Status> = {
  finding: "idle",
  planning: "running",
  awaiting_gate1: "parked",
  implementing: "running",
  verifying: "running",
  awaiting_gate2: "parked",
  shipped: "done",
};

function hrefForStage(runId: string, stage: BoardStage): string {
  const id = encodeURIComponent(runId);
  if (stage === "planning") return `/runs/${id}/plan?pending=1`;
  if (stage === "awaiting_gate1") return `/runs/${id}/plan`;
  if (stage === "awaiting_gate2" || stage === "shipped") return `/pr-checks/${id}`;
  return `/runs/${id}`;
}

export default async function HomePage() {
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();

  const { db, report } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let columns: BoardColumn[];
  let totalRuns = 0;
  let needsAttentionCount = 0;
  try {
    const runs = await listRuns(runsRoot);
    totalRuns = runs.length;

    const byStage = new Map<BoardStage, BoardCardData[]>(BOARD_STAGES.map((s) => [s, []]));

    for (const r of runs) {
      const plans = getPlans(db, r.runId);
      const currentPlan = resolveCurrentPlan(plans);
      const objections = currentPlan ? getObjections(db, currentPlan.plan_id) : [];
      const unresolved = unresolvedObjections(objections);
      const major = hasMajorUnresolved(objections);

      const hasVerifyVerdict = parseLatestEventOfKind<VerifyVerdictPayload>(db, r.runId, "verify_verdict") !== undefined;
      const hasReviewCompleted = parseLatestEventOfKind<ReviewCompletedPayload>(db, r.runId, "review_completed") !== undefined;
      const hasPrCreated = parseLatestEventOfKind<PrCreatedPayload>(db, r.runId, "pr_created") !== undefined;

      const stage = deriveBoardStage({
        state: r.state,
        plans,
        hasVerifyVerdict,
        hasReviewCompleted,
        hasPrCreated,
      });

      const issues = rebuildHealthIssues(r.runId, report, r.state.truncated);
      const healthy = isHealthy(issues);
      if (!healthy || stage === "awaiting_gate1" || stage === "awaiting_gate2") needsAttentionCount += 1;

      const lastTs = getLastEventTimestamp(db, r.runId);

      // B9: only meaningful while a live attempt actually exists -- every
      // other stage (parked, idle, done) has no live subprocess to be stale.
      const runningAttemptId = findRunningAttemptId(r.state);
      const rawLogMtimeMs = runningAttemptId
        ? await getRawLogMtimeMs(path.join(runsRoot, r.runId), runningAttemptId)
        : undefined;
      const liveness = runningAttemptId ? deriveLiveness(rawLogMtimeMs) : "n/a";

      const card: BoardCardData = {
        runId: r.runId,
        href: hrefForStage(r.runId, stage),
        pillStatus: STAGE_PILL_STATUS[stage],
        pillLabel: STAGE_LABELS[stage],
        healthy,
        healthIssueCount: issues.length,
        unresolvedObjectionCount: unresolved.length,
        hasMajorUnresolvedObjection: major,
        relativeTime: lastTs ? formatRelativeTime(lastTs) : undefined,
        fenceEpoch: r.state.fenceEpoch,
        liveness,
      };

      byStage.get(stage)!.push(card);
    }

    columns = BOARD_STAGES.map((stage) => ({ stage, cards: byStage.get(stage) ?? [] }));
  } finally {
    db.close();
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Operations / Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalRuns === 0
              ? "Your agent work will appear here."
              : `${totalRuns} session${totalRuns === 1 ? "" : "s"} across the delivery pipeline`}
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5 shadow-none">
          <Link href="/new">
            <Plus className="h-4 w-4" />
            New session
          </Link>
        </Button>
      </div>

      <WorkspaceClient defaultRepoRoot={getDefaultRepoRoot()} />

      {totalRuns > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Surface elevation="base" grain={false} className="flex items-center gap-3 p-3.5">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accent-foreground">
              <Layers3 className="h-4 w-4" />
            </span>
            <div>
              <div className="text-lg font-semibold leading-none text-foreground">{totalRuns}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">tracked sessions</div>
            </div>
          </Surface>
          <Surface elevation="base" grain={false} className="flex items-center gap-3 p-3.5">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-status-parked/15 text-status-parked">
              <CircleAlert className="h-4 w-4" />
            </span>
            <div>
              <div className="text-lg font-semibold leading-none text-foreground">{needsAttentionCount}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">need attention</div>
            </div>
          </Surface>
          <Surface elevation="base" grain={false} className="flex items-center justify-between gap-3 p-3.5">
            <div>
              <div className="text-sm font-semibold text-foreground">Read the full history</div>
              <div className="mt-1 text-[11px] text-muted-foreground">Search every recorded run</div>
            </div>
            <Link href="/runs" className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Open all runs">
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Surface>
        </div>
      )}

      {totalRuns === 0 ? (
        <EmptyState
          icon={<RotateCcw className="h-8 w-8" />}
          title="No sessions yet"
          description="Start one to see it move through the pipeline here: finding, planning, Review plan, implementing, verifying, PR check, PR opened."
          action={
            <Button asChild>
              <Link href="/new">Start a session</Link>
            </Button>
          }
        />
      ) : (
        <Surface elevation="base" className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Delivery pipeline</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">A read-only view of what the journal says is happening.</p>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              live index
            </span>
          </div>
          <BoardClient columns={columns} />
        </Surface>
      )}
    </div>
  );
}
