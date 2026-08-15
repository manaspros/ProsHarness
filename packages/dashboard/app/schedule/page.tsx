import { getScheduleStatusDir, listScheduleStatuses, type JobStatusRecord } from "../../lib/schedule-data";

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
    <div>
      <h1>Scheduled jobs</h1>
      <p>Status directory: {statusDir}</p>

      {statuses.length === 0 ? (
        <p>No scheduled jobs have run yet. Start the loop with `pros schedule start`.</p>
      ) : (
        statuses.map((s) => <JobStatusCard key={s.name} status={s} />)
      )}
    </div>
  );
}

function JobStatusCard({ status }: { status: JobStatusRecord }) {
  const isError = status.lastStatus === "error";
  const isNeverRun = status.lastStatus === "never-run";

  const badgeStyle = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: "bold",
    whiteSpace: "nowrap",
    background: isError ? "#fdd" : isNeverRun ? "#eee" : "#dfd",
    color: isError ? "#900" : isNeverRun ? "#444" : "#060",
  };

  return (
    <div
      style={{
        border: isError ? "1px solid #e99" : "1px solid #ddd",
        borderRadius: 4,
        padding: "12px 16px",
        marginBottom: 16,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{status.name}</strong>
        <span style={badgeStyle}>{isError ? "ERROR" : isNeverRun ? "NEVER RUN" : "OK"}</span>
      </div>
      <p>Last run: {status.lastRunAt ?? "never"}</p>
      <p>Next due: {status.nextDueAt ?? "n/a"}</p>
      {typeof status.lastDurationMs === "number" && <p>Last duration: {status.lastDurationMs}ms</p>}
      {isError && status.lastError && (
        <p style={{ color: "#900", fontWeight: "bold" }}>Error: {status.lastError}</p>
      )}
      {status.lastSummary && (
        <>
          <div>Last summary:</div>
          <pre style={{ background: "#f6f6f6", padding: 8, overflowX: "auto" }}>
            {JSON.stringify(status.lastSummary, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
