import Link from "next/link";
import { Inbox } from "lucide-react";

import { getRunsRoot, getIndexDbPath } from "../../lib/config";
import { listRuns } from "../../lib/list-runs";
import { rebuildAndOpenIndex } from "../../lib/db";
import { deriveRunStatus, RUN_STATUS_LABELS } from "../../lib/run-status";
import { rebuildHealthIssues, isHealthy } from "../../lib/health";
import { SectionHeading } from "../../components/SectionHeading";
import { Surface } from "../../components/Surface";
import { EmptyState } from "../../components/EmptyState";
import { ListRow } from "../../components/ListRow";
import { StatusPill, type Status } from "../../components/StatusPill";
import { Alert } from "../../components/Alert";

export const dynamic = "force-dynamic"; // always re-read the journal/index -- never cache a runs list

function statusPillProps(status: ReturnType<typeof deriveRunStatus>): { pillStatus: Status } {
  return { pillStatus: status.startsWith("parked") ? "parked" : (status as Status) };
}

export default async function RunsPage() {
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();

  // Rebuild the index first (cheap at single-user scale, per the brief),
  // then cross-reference every run against its rebuild report for health.
  const { db, report } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let runs;
  try {
    runs = await listRuns(runsRoot);
  } finally {
    db.close();
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Runs"
        description={
          <>
            Runs root: <code>{runsRoot}</code> &middot; Index: <code>{dbPath}</code> &middot; Last rebuild:{" "}
            {new Date().toISOString()}
          </>
        }
      />

      {report.truncatedRuns.length > 0 && (
        <Alert variant="warning" title="Truncated journal(s) detected">
          {report.truncatedRuns.length} run(s) have a truncated journal (torn/corrupt tail detected on last read):{" "}
          {report.truncatedRuns.join(", ")}
        </Alert>
      )}
      {report.rawLogParseIssues.length > 0 && (
        <Alert variant="warning" title="Raw log parse issues">
          {report.rawLogParseIssues.length} raw log line(s) across all runs failed to parse cleanly (malformed or
          unrecognized event type) -- see each run's detail page for specifics.
        </Alert>
      )}

      {runs.length === 0 ? (
        <Surface elevation="raised">
          <EmptyState icon={<Inbox className="h-8 w-8" />} title="No runs yet" description={`No runs under ${runsRoot}.`} />
        </Surface>
      ) : (
        <Surface elevation="raised" className="divide-y divide-border p-2">
          {runs.map((r) => {
            const status = deriveRunStatus(r.state);
            const issues = rebuildHealthIssues(r.runId, report, r.state.truncated);
            const healthy = isHealthy(issues);
            const { pillStatus } = statusPillProps(status);
            return (
              <Link key={r.runId} href={`/runs/${encodeURIComponent(r.runId)}`} className="block">
                <ListRow
                  leading={<StatusPill status={pillStatus} label="" />}
                  title={r.runId}
                  subtitle={`fence epoch ${r.state.fenceEpoch} · ${RUN_STATUS_LABELS[status]}`}
                  meta={
                    healthy ? (
                      <span className="text-muted-foreground">ok</span>
                    ) : (
                      <span className="font-semibold text-status-fail">
                        UNHEALTHY ({issues.length} issue{issues.length === 1 ? "" : "s"})
                      </span>
                    )
                  }
                />
              </Link>
            );
          })}
        </Surface>
      )}
    </div>
  );
}
