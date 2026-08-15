import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import { loadSessionGraph, groupNodesByAttempt, countUnknownNodes } from "../../../../lib/graph-data";

export const dynamic = "force-dynamic";

/** Plain-language description of a node kind, per the brief's "teaching, not jargon" goal. */
function kindLabel(kind: string): string {
  switch (kind) {
    case "prompt":
      return "prompt";
    case "tool_call":
      return "tool call";
    case "tool_result":
      return "tool result";
    case "subagent":
      return "subagent";
    case "skill":
      return "skill";
    case "unknown":
      return "unknown";
    default:
      return kind;
  }
}

export default async function GraphPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();

  const { db } = await rebuildAndOpenIndex(dbPath, runsRoot);
  let graph;
  try {
    graph = loadSessionGraph(db, runId);
  } finally {
    db.close();
  }

  const unknownCount = countUnknownNodes(graph);
  const grouped = groupNodesByAttempt(graph.nodes);

  const toolCountsSummary = Object.entries(graph.summary.toolCounts)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  const subagentsSummary =
    graph.summary.subagentsSpawned > 0 ? `${graph.summary.subagentsSpawned} subagent${graph.summary.subagentsSpawned === 1 ? "" : "s"} spawned` : "no subagents spawned";
  const skillsSummary = graph.summary.skillsInvoked.length > 0 ? `skill${graph.summary.skillsInvoked.length === 1 ? "" : "s"} used: ${graph.summary.skillsInvoked.join(", ")}` : "no skills used";
  const filesSummary = graph.summary.filesWritten.length > 0 ? `${graph.summary.filesWritten.length} file(s) written` : "no files written";
  const bashVerbsSummary = graph.summary.bashVerbs.length > 0 ? `bash verbs: ${graph.summary.bashVerbs.join(", ")}` : "no bash calls";

  return (
    <div>
      <p>
        <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; run overview</a>
      </p>
      <h1>Session graph for run {runId}</h1>

      {unknownCount > 0 && (
        <div className="warning-banner">
          {unknownCount} event(s) in this run's raw log could not be parsed cleanly -- shown below as Unknown, never
          hidden.
        </div>
      )}

      <p>
        {toolCountsSummary ? `${toolCountsSummary}. ` : "No tool calls. "}
        {subagentsSummary}. {skillsSummary}. {filesSummary}. {bashVerbsSummary}.
      </p>

      <h2>Timeline ({graph.nodes.length} node(s))</h2>
      {grouped.length === 0 ? (
        <p>No events recorded for this run yet.</p>
      ) : (
        grouped.map((group) => (
          <div key={group.attemptId}>
            <h3>
              Attempt <code>{group.attemptId}</code>
            </h3>
            <table>
              <thead>
                <tr>
                  <th>seq</th>
                  <th>kind</th>
                  <th>label</th>
                  <th>raw event</th>
                </tr>
              </thead>
              <tbody>
                {group.nodes.map((node) => (
                  <tr key={node.id}>
                    <td>{node.seq}</td>
                    <td>
                      <span className={node.kind === "unknown" ? "badge fail" : "badge"}>{kindLabel(node.kind)}</span>
                    </td>
                    <td>{node.label}</td>
                    <td>
                      <code>raw_events#{node.rawEventId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <p>
        <a href={`/runs/${encodeURIComponent(runId)}`}>&larr; back to run overview</a>
      </p>
    </div>
  );
}
