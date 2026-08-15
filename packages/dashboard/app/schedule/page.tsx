import { Clock } from "lucide-react";

import { getScheduleStatusDir, listScheduleStatuses, type JobStatusRecord } from "../../lib/schedule-data";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill, type Status } from "../../components/StatusPill";
import { cn } from "../../lib/utils";

export const dynamic = "force-dynamic";

/**
 * The scheduled-jobs page (M7). Purely informational: it renders the
 * durable status file each @pros/schedule job writes after every attempt.
 * A failed job's error message must always be visible here -- this page
 * must never make a failing scheduled pass look healthy (see
 * lib/health.ts's house philosophy, applied here to scheduled jobs
 * instead of run journals). No form element, no click/submit handlers, no
 * fetch/mutation, no client component. See test/schedule-data.test.ts's
 * static-inspection test.
 */
export default function SchedulePage() {
  const statusDir = getScheduleStatusDir();
  const statuses = listScheduleStatuses(statusDir);

  return (
    <div className="space-y-6">
      <SectionHeading title="Scheduled jobs" description={<>Status directory: <code>{statusDir}</code></>} />

      {statuses.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState
            icon={<Clock className="h-8 w-8" />}
            title="No scheduled jobs have run yet"
            description="Start the loop with `pros schedule start`."
          />
        </Surface>
      ) : (
        <div className="space-y-4">
          {statuses.map((s) => (
            <JobStatusCard key={s.name} status={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobStatusCard({ status }: { status: JobStatusRecord }) {
  const isError = status.lastStatus === "error";
  const isNeverRun = status.lastStatus === "never-run";
  const pillStatus: Status = isError ? "fail" : isNeverRun ? "idle" : "pass";
  const pillLabel = isError ? "error" : isNeverRun ? "never run" : "ok";

  return (
    <Surface
      elevation="raised"
      className={cn("space-y-2 p-5", isError && "border-status-fail/40")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm font-semibold text-foreground">{status.name}</strong>
        <StatusPill status={pillStatus} label={pillLabel} />
      </div>
      <p className="text-sm text-muted-foreground">Last run: {status.lastRunAt ?? "never"}</p>
      <p className="text-sm text-muted-foreground">Next due: {status.nextDueAt ?? "n/a"}</p>
      {typeof status.lastDurationMs === "number" && (
        <p className="text-sm text-muted-foreground">Last duration: {status.lastDurationMs}ms</p>
      )}
      {isError && status.lastError && (
        <p className="text-sm font-semibold text-status-fail">Error: {status.lastError}</p>
      )}
      {status.lastSummary && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-xs font-medium text-muted-foreground">Last summary</div>
          <pre className="max-w-full overflow-x-auto rounded-md border border-border bg-surface-base p-3 font-mono text-xs text-foreground/80">
            {JSON.stringify(status.lastSummary, null, 2)}
          </pre>
        </div>
      )}
    </Surface>
  );
}
