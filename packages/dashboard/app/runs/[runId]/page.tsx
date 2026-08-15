import path from "node:path";
import { notFound } from "next/navigation";
import { loadRunState, readManifest } from "@pros/barrier";
import { getRunsRoot, getIndexDbPath } from "../../../lib/config";
import { rebuildAndOpenIndex } from "../../../lib/db";
import { rebuildHealthIssues, queryUnknownJournalKinds, isHealthy, type HealthIssue } from "../../../lib/health";
import { deriveRunStatus, RUN_STATUS_LABELS } from "../../../lib/run-status";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  const state = await loadRunState(runDir).catch(() => undefined);
  if (!state) {
    // Either the run doesn't exist, or its journal is entirely unreadable
    // (not merely truncated -- loadRunState still returns a state object for
    // a truncated-but-partially-readable journal; only a hard failure, e.g.
    // permission error, lands here).
    notFound();
  }

  const manifest = await readManifest(runDir).catch(() => undefined);

  const dbPath = getIndexDbPath();
  const { db, report } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let unknownKinds: string[] = [];
  try {
    unknownKinds = queryUnknownJournalKinds(db, runId);
  } finally {
    db.close();
  }

  const issues: HealthIssue[] = [
    ...rebuildHealthIssues(runId, report, state.truncated),
    ...unknownKinds.map((k) => ({
      kind: "unknown_journal_kind" as const,
      detail: `journal entry kind "${k}" is not recognized by this dashboard's copy of @pros/barrier -- it was preserved verbatim in the index but had NO effect on run-state projection. It may be from a newer/different journal writer.`,
    })),
  ];
  const healthy = isHealthy(issues);
  const status = deriveRunStatus(state);

  return (
    <div>
      <p>
        <a href="/runs">&larr; all runs</a>
      </p>
      <h1>
        Run <code>{runId}</code>
      </h1>

      {!healthy && (
        <div className="warning-banner">
          <div>WARNING -- this run's history may be INCOMPLETE or contain UNPARSED events. Do not treat it as healthy.</div>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                <strong>[{issue.kind}]</strong> {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p>
        Status: <span className={`badge ${status.startsWith("parked") ? "parked" : status}`}>{RUN_STATUS_LABELS[status]}</span>
      </p>
      <p>Fence epoch: {state.fenceEpoch}</p>
      <p>Last journal seq: {state.lastSeq}</p>
      <p>Journal truncated (per last read): {state.truncated ? "YES" : "no"}</p>

      <h2>Manifest</h2>
      {manifest ? (
        <table>
          <tbody>
            <tr>
              <th>cwd</th>
              <td>{manifest.cwd}</td>
            </tr>
            <tr>
              <th>headSha</th>
              <td>{manifest.headSha}</td>
            </tr>
            <tr>
              <th>baseSha</th>
              <td>{manifest.baseSha}</td>
            </tr>
            <tr>
              <th>fenceEpoch (at snapshot)</th>
              <td>{manifest.fenceEpoch}</td>
            </tr>
            <tr>
              <th>createdAt</th>
              <td>{manifest.createdAt}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p>No manifest yet (run has never parked).</p>
      )}

      <h2>Attempts ({state.attempts.size})</h2>
      {state.attempts.size === 0 ? (
        <p>None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Attempt ID</th>
              <th>cwd</th>
              <th>Unit name</th>
              <th>Fence epoch at start</th>
              <th>Ended reason</th>
            </tr>
          </thead>
          <tbody>
            {[...state.attempts.values()].map((a) => (
              <tr key={a.attemptId}>
                <td>{a.attemptId}</td>
                <td>{a.cwd}</td>
                <td>{a.unitName}</td>
                <td>{a.fenceEpochAtStart}</td>
                <td>{a.endedReason ?? "(still running)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Checkpoints ({state.checkpoints.size})</h2>
      {state.checkpoints.size === 0 ? (
        <p>None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Checkpoint ID</th>
              <th>Gate type</th>
              <th>Phase</th>
              <th>Prompt</th>
            </tr>
          </thead>
          <tbody>
            {[...state.checkpoints.values()].map((cp) => (
              <tr key={cp.checkpointId}>
                <td>{cp.checkpointId}</td>
                <td>{cp.gateType ?? "ask_human"}</td>
                <td>{cp.phase}</td>
                <td>{cp.prompt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <a href={`/runs/${encodeURIComponent(runId)}/plan`}>Plan &rarr;</a>
        {" | "}
        <a href={`/runs/${encodeURIComponent(runId)}/questions`}>Questions &rarr;</a>
      </p>
    </div>
  );
}
