import path from "node:path";
import { loadRunState } from "@pros/barrier";
import { getRunsRoot } from "../../../../lib/config";
import { ANSWER_EFFECTS, DEFAULT_ANSWER_EFFECT } from "../../../../lib/gate-actions";

export const dynamic = "force-dynamic";

export default async function QuestionsPage({
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
  if (!state) {
    return (
      <div>
        <p>
          <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; run overview</a>
        </p>
        <p>Could not read this run's state.</p>
      </div>
    );
  }

  const questions = [...state.checkpoints.values()].filter((cp) => (cp.gateType ?? "ask_human") === "ask_human");

  return (
    <div>
      <p>
        <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; run overview</a>
      </p>
      <h1>Questions for run {runId}</h1>

      {error && <div className="error-banner">Error: {error}</div>}

      {questions.length === 0 ? (
        <p>No ask_human checkpoints for this run.</p>
      ) : (
        questions.map((cp) => (
          <div key={cp.checkpointId} style={{ border: "1px solid #ddd", borderRadius: 4, padding: 12, marginBottom: 12 }}>
            <p>
              <strong>Prompt:</strong> {cp.prompt}
            </p>
            <p>
              Phase: <span className={`badge ${cp.phase === "parked" ? "parked" : ""}`}>{cp.phase}</span>
              {" | Options: "}
              {cp.options.length > 0 ? cp.options.join(", ") : "(none -- free text only)"}
            </p>
            {cp.answer !== undefined ? (
              <p>
                <strong>Answer:</strong> {cp.answer} <em>[{cp.effect}]</em>
              </p>
            ) : cp.phase === "parked" ? (
              <form
                action={`/api/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(cp.checkpointId)}/answer`}
                method="post"
              >
                <input type="hidden" name="redirectTo" value={`/runs/${encodeURIComponent(runId)}/questions`} />
                <div>
                  {cp.options.length > 0 ? (
                    <select name="answer" defaultValue={cp.options[0]}>
                      {cp.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {" or free text: "}
                  <input type="text" name="answerFreeText" placeholder="(used if no option selected above matches)" />
                </div>
                <div style={{ marginTop: 6 }}>
                  Effect:{" "}
                  <select name="effect" defaultValue={DEFAULT_ANSWER_EFFECT}>
                    {ANSWER_EFFECTS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                  <button type="submit" style={{ marginLeft: 12 }}>
                    Submit answer
                  </button>
                </div>
              </form>
            ) : (
              <p style={{ color: "#666" }}>Not currently parked (phase: {cp.phase}) -- nothing to answer right now.</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
