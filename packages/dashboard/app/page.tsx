import Link from "next/link";
import { RotateCcw } from "lucide-react";

import { getRunsRoot, getIndexDbPath } from "@/lib/config";
import { listRuns } from "@/lib/list-runs";
import { rebuildAndOpenIndex } from "@/lib/db";
import { rebuildHealthIssues, isHealthy } from "@/lib/health";
import { parseLatestEventOfKind, type VerifyVerdictPayload, type ReviewCompletedPayload, type PrCreatedPayload } from "@/lib/review-data";
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
import { SectionHeading } from "@/components/SectionHeading";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { BoardClient, type BoardColumn } from "@/components/board/BoardClient";
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
  if (stage === "awaiting_gate1") return `/runs/${id}/plan`;
  if (stage === "awaiting_gate2" || stage === "shipped") return `/runs/${id}/review`;
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
      };

      byStage.get(stage)!.push(card);
    }

    columns = BOARD_STAGES.map((stage) => ({ stage, cards: byStage.get(stage) ?? [] }));
  } finally {
    db.close();
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 p-6">
      <SectionHeading
        as="h1"
        title="Sessions"
        description={
          totalRuns === 0
            ? "No sessions yet."
            : `${totalRuns} session${totalRuns === 1 ? "" : "s"} total · ${needsAttentionCount} need${needsAttentionCount === 1 ? "s" : ""} attention`
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/new">New session</Link>
          </Button>
        }
      />

      {totalRuns === 0 ? (
        <EmptyState
          icon={<RotateCcw className="h-8 w-8" />}
          title="No sessions yet"
          description="Start one to see it move through the pipeline here: finding, planning, awaiting Gate 1, implementing, verifying, awaiting Gate 2, PR opened."
          action={
            <Button asChild>
              <Link href="/new">Start a session</Link>
            </Button>
          }
        />
      ) : (
        <BoardClient columns={columns} />
      )}
    </div>
  );
}
