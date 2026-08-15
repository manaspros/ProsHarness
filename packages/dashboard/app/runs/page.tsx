import { getRunsRoot, getIndexDbPath } from "../../lib/config";
import { listRuns } from "../../lib/list-runs";
import { rebuildAndOpenIndex } from "../../lib/db";
import { deriveRunStatus, RUN_STATUS_LABELS } from "../../lib/run-status";
import { rebuildHealthIssues, isHealthy } from "../../lib/health";

export const dynamic = "force-dynamic"; // always re-read the journal/index -- never cache a runs list

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
    <div>
      <h1>Runs</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        Runs root: <code>{runsRoot}</code> &middot; Index: <code>{dbPath}</code> &middot; Last rebuild:{" "}
        {new Date().toISOString()}
      </p>

      {report.truncatedRuns.length > 0 && (
        <div className="warning-banner">
          {report.truncatedRuns.length} run(s) have a truncated journal (torn/corrupt tail detected on last read):{" "}
          {report.truncatedRuns.join(", ")}
        </div>
      )}
      {report.rawLogParseIssues.length > 0 && (
        <div className="warning-banner">
          {report.rawLogParseIssues.length} raw log line(s) across all runs failed to parse cleanly (malformed or
          unrecognized event type) -- see each run's detail page for specifics.
        </div>
      )}

      {runs.length === 0 ? (
        <p>No runs yet under {runsRoot}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Fence epoch</th>
              <th>Status</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const status = deriveRunStatus(r.state);
              const issues = rebuildHealthIssues(r.runId, report, r.state.truncated);
              const healthy = isHealthy(issues);
              return (
                <tr key={r.runId}>
                  <td>
                    <a href={`/runs/${encodeURIComponent(r.runId)}`}>{r.runId}</a>
                  </td>
                  <td>{r.state.fenceEpoch}</td>
                  <td>
                    <span className={`badge ${status.startsWith("parked") ? "parked" : status}`}>
                      {RUN_STATUS_LABELS[status]}
                    </span>
                  </td>
                  <td>
                    {healthy ? (
                      "ok"
                    ) : (
                      <span style={{ color: "#c0392b", fontWeight: "bold" }}>
                        UNHEALTHY ({issues.length} issue{issues.length === 1 ? "" : "s"})
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
