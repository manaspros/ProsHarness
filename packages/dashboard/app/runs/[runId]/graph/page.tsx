import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  HelpCircle,
  MessageSquare,
  Share2,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { getRunsRoot, getIndexDbPath } from "../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../lib/db";
import { loadSessionGraph, groupNodesByAttempt, countUnknownNodes } from "../../../../lib/graph-data";
import { SectionHeading } from "../../../../components/SectionHeading";
import { Surface } from "../../../../components/Surface";
import { EmptyState } from "../../../../components/EmptyState";
import { Alert } from "../../../../components/Alert";
import { cn } from "../../../../lib/utils";

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

const KIND_ICON: Record<string, LucideIcon> = {
  prompt: MessageSquare,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  subagent: Users,
  skill: Sparkles,
  unknown: HelpCircle,
};

const KIND_COLOR: Record<string, string> = {
  prompt: "border-status-running/40 bg-status-running/15 text-status-running",
  tool_call: "border-primary/40 bg-primary/15 text-primary",
  tool_result: "border-status-pass/40 bg-status-pass/15 text-status-pass",
  subagent: "border-status-parked/40 bg-status-parked/15 text-status-parked",
  skill: "border-status-idle/40 bg-status-idle/20 text-foreground",
  unknown: "border-status-fail/40 bg-status-fail/15 text-status-fail",
};

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
    <div className="space-y-6">
      <Link href={`/runs/${encodeURIComponent(runId)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> run overview
      </Link>

      <SectionHeading title="Session graph" description={<code>{runId}</code>} />

      {unknownCount > 0 && (
        <Alert variant="warning" title="Unparsed events present">
          {unknownCount} event(s) in this run&apos;s raw log could not be parsed cleanly -- shown below as Unknown, never hidden.
        </Alert>
      )}

      <Surface elevation="raised" className="p-5 text-sm text-muted-foreground">
        {toolCountsSummary ? `${toolCountsSummary}. ` : "No tool calls. "}
        {subagentsSummary}. {skillsSummary}. {filesSummary}. {bashVerbsSummary}.
      </Surface>

      <section className="space-y-4">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">
          Timeline ({graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"})
        </h3>

        {grouped.length === 0 ? (
          <Surface elevation="raised">
            <EmptyState icon={<Share2 className="h-8 w-8" />} title="No events recorded" description="Nothing has happened in this run yet." />
          </Surface>
        ) : (
          <div className="space-y-6">
            {grouped.map((group) => (
              <Surface key={group.attemptId} elevation="raised" className="p-5">
                <h4 className="mb-4 text-sm font-semibold text-foreground">
                  Attempt <code className="font-mono text-xs text-muted-foreground">{group.attemptId}</code>
                </h4>

                <ol className="relative space-y-4 border-l border-border pl-6">
                  {group.nodes.map((node) => {
                    const Icon = KIND_ICON[node.kind] ?? HelpCircle;
                    const colorClass = KIND_COLOR[node.kind] ?? KIND_COLOR.unknown;
                    return (
                      <li key={node.id} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[calc(1.5rem+9px)] flex h-6 w-6 items-center justify-center rounded-full border",
                            colorClass,
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-xs font-mono text-muted-foreground">#{node.seq}</span>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                              colorClass,
                            )}
                          >
                            {kindLabel(node.kind)}
                          </span>
                          <span className="text-sm text-foreground">{node.label}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          <code>raw_events#{node.rawEventId}</code>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Surface>
            ))}
          </div>
        )}
      </section>

      <Link href={`/runs/${encodeURIComponent(runId)}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> back to run overview
      </Link>
    </div>
  );
}
