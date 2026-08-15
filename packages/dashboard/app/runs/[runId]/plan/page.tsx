import path from "node:path";
import { loadRunState } from "@pros/barrier";
import { getPlans, getObjections } from "@pros/index";
import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import { resolveCurrentPlan } from "../../../../lib/plan-doc";
import { PLAN_APPROVAL_ACTIONS } from "../../../../lib/gate-actions";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { runId } = await params;
  const { error } = await searchParams;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  const state = await loadRunState(runDir).catch(() => undefined);

  const dbPath = getIndexDbPath();
  const { db } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let plans, objections;
  try {
    plans = getPlans(db, runId);
    const current = resolveCurrentPlan(plans);
    objections = current ? getObjections(db, current.plan_id) : [];
  } finally {
    db.close();
  }

  const current = resolveCurrentPlan(plans);
  // "Unresolved" = no resolution recorded yet, or explicitly not accepted.
  const unresolvedObjections = objections.filter((o) => !o.resolution || o.resolution !== "accepted");

  // Find a parked plan_approval checkpoint for this run, if any -- the
  // Approve/Amendment/Reject buttons only appear when one exists, and use
  // ITS OWN questionId/idempotencyKey (never invented ones), per the brief.
  const parkedApprovalCheckpoint = state
    ? [...state.checkpoints.values()].find((cp) => cp.gateType === "plan_approval" && cp.phase === "parked")
    : undefined;

  return (
    <div>
      <p>
        <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; run overview</a>
      </p>
      <h1>Plan for run {runId}</h1>

      {error && <div className="error-banner">Error: {error}</div>}

      {!current ? (
        <p>No plan has been drafted for this run yet.</p>
      ) : (
        <>
          <p>
            Plan <code>{current.plan_id}</code>, version {current.version}, state <code>{current.state}</code>
            {current.edited_at && (
              <>
                {" "}
                -- last edited {current.edited_at} by <strong>{current.edited_by}</strong>
              </>
            )}
          </p>

          <h2>Current document</h2>
          <pre className="plan-markdown">{current.markdown}</pre>

          <h2>Unresolved objections ({unresolvedObjections.length})</h2>
          {unresolvedObjections.length === 0 ? (
            <p>None outstanding.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Author</th>
                  <th>Severity</th>
                  <th>Claim</th>
                  <th>Suggested change</th>
                </tr>
              </thead>
              <tbody>
                {unresolvedObjections.map((o) => (
                  <tr key={o.id}>
                    <td>{o.round}</td>
                    <td>{o.author}</td>
                    <td>{o.severity ?? "?"}</td>
                    <td>{o.claim ?? ""}</td>
                    <td>{o.suggested_change ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {parkedApprovalCheckpoint && (
            <>
              <h2>Gate 1: plan approval (parked)</h2>
              <p>{parkedApprovalCheckpoint.prompt}</p>
              <div>
                {PLAN_APPROVAL_ACTIONS.map((action) => (
                  <form
                    key={action}
                    action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(
                      parkedApprovalCheckpoint.checkpointId,
                    )}/answer`}
                    method="post"
                    style={{ display: "inline" }}
                  >
                    <input type="hidden" name="planAction" value={action} />
                    <input type="hidden" name="answer" value={action} />
                    <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/plan`} />
                    <button type="submit">
                      {action === "approve" ? "Approve" : action === "request_amendment" ? "Request Amendment" : "Reject"}
                    </button>
                  </form>
                ))}
              </div>
            </>
          )}

          <h2>Edit plan document</h2>
          <p style={{ color: "#666", fontSize: 13 }}>
            Saving an edit rewrites plan.md and appends a <code>plan_edited</code> journal entry. It does NOT touch the
            fence epoch or any attempt/checkpoint state -- it works whether or not a checkpoint is currently parked.
          </p>
          <form action={`/api/runs/${encodeURIComponent(runId)}/plan/edit`} method="post">
            <input type="hidden" name="planId" value={current.plan_id} />
            <input type="hidden" name="version" value={current.version} />
            <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/plan`} />
            <div>
              <textarea name="markdown" rows={20} style={{ width: "100%" }} defaultValue={current.markdown} />
            </div>
            <div style={{ marginTop: 8 }}>
              <label>
                Edited by: <input type="text" name="editedBy" defaultValue="human" />
              </label>
              <button type="submit" style={{ marginLeft: 12 }}>
                Save edit
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
