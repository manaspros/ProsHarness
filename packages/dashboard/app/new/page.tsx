import Link from "next/link";
import { ListChecks } from "lucide-react";

import { Surface } from "@/components/Surface";
import { SectionHeading } from "@/components/SectionHeading";
import { EmptyState } from "@/components/EmptyState";
import { ListRow } from "@/components/ListRow";
import { StatusPill, type Status } from "@/components/StatusPill";
import { getRunsRoot } from "@/lib/config";
import { listRuns } from "@/lib/list-runs";
import { deriveRunStatus, RUN_STATUS_LABELS, type RunStatusLabel } from "@/lib/run-status";
import { NewSessionForm } from "./NewSessionForm";

export const dynamic = "force-dynamic"; // always reflect the latest queued/running runs, never cache

function toPillStatus(label: RunStatusLabel): Status {
  if (label.startsWith("parked")) return "parked";
  return label as Status; // "running" | "idle" | "done" all match Status directly.
}

export default async function NewSessionPage() {
  const runsRoot = getRunsRoot();
  const runs = await listRuns(runsRoot).catch(() => []);

  const active = runs
    .map((r) => ({ run: r, status: deriveRunStatus(r.state) }))
    .filter(({ status }) => status !== "done" && status !== "idle")
    .reverse(); // most-recently-created first, matching the sidebar's convention

  const isFirstRun = runs.length === 0;

  return (
    <div className="flex flex-col gap-10">
      <NewSessionForm isFirstRun={isFirstRun} />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <SectionHeading
          as="h3"
          title="Queued and running"
          description="Runs currently parked (awaiting a decision) or actively running."
        />

        {active.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="h-6 w-6" />}
            title="Nothing running right now"
            description="Launch a session above to get started -- it'll show up here once the finding/plan pass begins."
          />
        ) : (
          <Surface elevation="raised" className="p-2">
            <div className="flex flex-col gap-0.5">
              {active.map(({ run, status }) => (
                <Link key={run.runId} href={`/runs/${encodeURIComponent(run.runId)}`} className="block">
                  <ListRow
                    leading={<StatusPill status={toPillStatus(status)} dot label="" />}
                    title={run.runId}
                    subtitle={RUN_STATUS_LABELS[status]}
                  />
                </Link>
              ))}
            </div>
          </Surface>
        )}
      </div>
    </div>
  );
}
