import Link from "next/link";
import { ClipboardCheck, Plus } from "lucide-react";
import { getPlans, getObjections } from "@pros/index";
import { listRuns } from "../../lib/list-runs";
import { rebuildAndOpenIndex } from "../../lib/db";
import { resolveCurrentPlan } from "../../lib/plan-doc";
import { getIndexDbPath, getRunsRoot } from "../../lib/config";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";
import { ListRow } from "../../components/ListRow";
import { StatusPill } from "../../components/StatusPill";
import { Button } from "../../components/ui/button";

export const dynamic = "force-dynamic";

/** Workspace-level inbox for Gate 1 plan approvals. */
export default async function PlansInboxPage() {
  const runsRoot = getRunsRoot();
  const runs = await listRuns(runsRoot);
  const { db } = await rebuildAndOpenIndex(getIndexDbPath(), runsRoot);
  const pending = [] as Array<{
    runId: string;
    checkpointId: string;
    prompt: string;
    version: number | undefined;
    objectionCount: number;
  }>;

  try {
    for (const run of runs) {
      const checkpoint = [...run.state.checkpoints.values()].find(
        (cp) => cp.gateType === "plan_approval" && cp.phase === "parked",
      );
      if (!checkpoint) continue;

      const current = resolveCurrentPlan(getPlans(db, run.runId));
      pending.push({
        runId: run.runId,
        checkpointId: checkpoint.checkpointId,
        prompt: checkpoint.prompt,
        version: current?.version,
        objectionCount: current ? getObjections(db, current.plan_id).filter((o) => o.resolution !== "accepted").length : 0,
      });
    }
  } finally {
    db.close();
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        as="h1"
        title="Review plans"
        description="Gate 1 plans waiting for your approval. Choose a session to inspect the full plan and objections."
        action={
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/new">
              <Plus className="h-4 w-4" /> New session
            </Link>
          </Button>
        }
      />

      {pending.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState
            icon={<ClipboardCheck className="h-8 w-8" />}
            title="No plans waiting for review"
            description="When a triggered session reaches Gate 1, its plan will appear here."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/new">Start a session</Link>
              </Button>
            }
          />
        </Surface>
      ) : (
        <Surface elevation="raised" className="divide-y divide-border p-2">
          {pending.map((item) => (
            <Link key={item.checkpointId} href={`/runs/${encodeURIComponent(item.runId)}/plan`} className="block">
              <ListRow
                leading={<StatusPill status="parked" label="Review plan" />}
                title={item.runId}
                subtitle={`${item.version === undefined ? "Plan" : `Plan v${item.version}`} · ${item.objectionCount} open objection${item.objectionCount === 1 ? "" : "s"}`}
                meta="Open →"
              />
            </Link>
          ))}
        </Surface>
      )}
    </div>
  );
}
