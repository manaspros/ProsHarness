// Builds a "session graph" -- a teaching-facing view of what happened in a
// run -- purely by reading the already-rebuilt `raw_events` SQLite table
// (owned by @pros/index) and re-parsing each row's verbatim raw_text via
// @pros/adapters' PURE parsers (parseClaudeLine/parseCodexLine). This
// function does no I/O beyond one SELECT, spawns no subprocess, and calls
// no model -- it is safe to run on every dashboard page load.
//
// Provenance invariant (load-bearing, tested in test/graph.test.ts): every
// GraphNode.rawEventId must be the real `raw_events.id` primary key of the
// row it was derived from, so a UI (or a test) can always trace a node back
// to the exact on-disk line that produced it.
//
// Tolerant-parsing invariant (D12, docs/00-decisions.md /
// docs/03-architecture.md): a raw_events row whose parse_status isn't "ok"
// must still produce a node (kind "unknown"), never be silently dropped.
// Likewise, a row that IS parse_status "ok" but whose *shape* this package
// doesn't specifically model (e.g. a claude "system"/"rate_limit_event"
// event, or a codex "thread.started"/"turn.started"/"turn.completed" event)
// also becomes a single "unknown" node rather than vanishing -- "unknown"
// here means "not specifically modeled by this graph", which is a superset
// of "not JSON" / "not a known top-level type".

import type Database from "better-sqlite3";
import { parseClaudeLine, parseCodexLine } from "@pros/adapters";
import type { ParsedEvent } from "@pros/adapters";

export type GraphNodeKind = "prompt" | "tool_call" | "tool_result" | "subagent" | "skill" | "unknown";

export interface GraphNode {
  id: string;
  runId: string;
  attemptId: string;
  rawEventId: number;
  seq: number;
  provider: "claude" | "codex";
  kind: GraphNodeKind;
  label: string;
  detail?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "sequence" | "tool_result_of";
}

export interface SessionGraph {
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: {
    toolCounts: Record<string, number>;
    subagentsSpawned: number;
    skillsInvoked: string[];
    filesWritten: string[];
    bashVerbs: string[];
  };
}

interface RawEventRow {
  id: number;
  run_id: string;
  attempt_id: string;
  seq: number;
  provider: string;
  parse_status: string;
  raw_text: string;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function firstWord(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^\S+/);
  return m ? m[0] : trimmed;
}

/** Mutable accumulators threaded through node construction, folded into SessionGraph.summary at the end. */
interface SummaryAcc {
  toolCounts: Record<string, number>;
  subagentsSpawned: number;
  skillsInvoked: Set<string>;
  filesWritten: Set<string>;
  bashVerbs: Set<string>;
}

function newSummaryAcc(): SummaryAcc {
  return { toolCounts: {}, subagentsSpawned: 0, skillsInvoked: new Set(), filesWritten: new Set(), bashVerbs: new Set() };
}

function bumpTool(acc: SummaryAcc, name: string): void {
  acc.toolCounts[name] = (acc.toolCounts[name] ?? 0) + 1;
}

/**
 * Classify + label a single claude `tool_use` content item. Returns the
 * GraphNodeKind and a human-facing label/detail -- no side effects.
 */
function describeClaudeToolUse(item: {
  name?: string;
  input?: Record<string, unknown>;
}): { kind: GraphNodeKind; label: string; detail: Record<string, unknown> } {
  const name = typeof item.name === "string" ? item.name : "unknown_tool";
  const input = item.input ?? {};

  if (name === "Task") {
    const subagentType = typeof input["subagent_type"] === "string" ? (input["subagent_type"] as string) : undefined;
    const description = typeof input["description"] === "string" ? (input["description"] as string) : undefined;
    return { kind: "subagent", label: `Task: ${subagentType ?? description ?? "subagent"}`, detail: { tool: name, input } };
  }
  if (name === "Skill") {
    const skill = typeof input["skill"] === "string" ? (input["skill"] as string) : typeof input["command"] === "string" ? (input["command"] as string) : "";
    return { kind: "skill", label: `Skill: ${skill}`, detail: { tool: name, input } };
  }
  if (name === "Bash") {
    const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
    return { kind: "tool_call", label: `Bash: ${truncate(command)}`, detail: { tool: name, input } };
  }
  if (name === "Read" || name === "Write" || name === "Edit") {
    const filePath = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
    return { kind: "tool_call", label: `${name} ${filePath}`, detail: { tool: name, input } };
  }
  // Any other tool (WebFetch, Glob, Grep, ...): generic but still legible.
  return { kind: "tool_call", label: `${name}${Object.keys(input).length ? ": " + truncate(JSON.stringify(input)) : ""}`, detail: { tool: name, input } };
}

function updateSummaryForToolUse(acc: SummaryAcc, name: string, input: Record<string, unknown>, kind: GraphNodeKind): void {
  bumpTool(acc, name);
  if (kind === "subagent") acc.subagentsSpawned++;
  if (kind === "skill") {
    const skill = typeof input["skill"] === "string" ? (input["skill"] as string) : typeof input["command"] === "string" ? (input["command"] as string) : "";
    if (skill) acc.skillsInvoked.add(skill);
  }
  if ((name === "Write" || name === "Edit") && typeof input["file_path"] === "string") {
    acc.filesWritten.add(input["file_path"] as string);
  }
  if (name === "Bash" && typeof input["command"] === "string") {
    acc.bashVerbs.add(firstWord(input["command"] as string));
  }
}

/**
 * Reads raw_events for runId from an already-open @pros/index SQLite db,
 * re-parses each row via @pros/adapters' pure parsers, and returns a
 * SessionGraph. Synchronous, no I/O beyond the one SELECT below, no
 * subprocess, no model call -- see the "zero LLM involvement" test.
 */
export function buildSessionGraph(db: Database.Database, runId: string): SessionGraph {
  const rows = db
    .prepare(`SELECT id, run_id, attempt_id, seq, provider, parse_status, raw_text FROM raw_events WHERE run_id = ? ORDER BY attempt_id, seq`)
    .all(runId) as RawEventRow[];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const acc = newSummaryAcc();

  // Maps a claude tool_use_id -> the tool_call node id, so a later
  // tool_result event in the same attempt can be linked back to it via a
  // "tool_result_of" edge.
  const pendingToolUse = new Map<string, string>();

  // Tracks the last node id emitted per attempt, so we can draw a
  // "sequence" edge from it to the next node in that same attempt.
  const lastNodeIdByAttempt = new Map<string, string>();

  function pushNode(node: GraphNode): void {
    nodes.push(node);
    const prev = lastNodeIdByAttempt.get(node.attemptId);
    if (prev !== undefined) edges.push({ from: prev, to: node.id, kind: "sequence" });
    lastNodeIdByAttempt.set(node.attemptId, node.id);
  }

  for (const row of rows) {
    const nodeId = `${row.run_id}:${row.attempt_id}:${row.seq}`;
    const provider = row.provider === "codex" ? "codex" : "claude"; // raw_events.provider can be "unknown" (see @pros/index's sidecar fallback) -- default to claude's parser, whose tolerant unknown_type/malformed handling still surfaces the row safely as "unknown".

    if (row.parse_status !== "ok") {
      // Malformed or unknown_type: never silently drop. One "unknown" node,
      // still carrying the real rawEventId, per the standing invariant.
      pushNode({
        id: nodeId,
        runId: row.run_id,
        attemptId: row.attempt_id,
        rawEventId: row.id,
        seq: row.seq,
        provider,
        kind: "unknown",
        label: `unknown (${row.parse_status})`,
        detail: { rawTextPreview: truncate(row.raw_text, 120) },
      });
      continue;
    }

    // parse_status is "ok": re-parse via the matching pure adapter to get
    // structured `type`/`data`. This re-derives what @pros/index's own
    // (independent, intentionally adapter-free) classifier already decided
    // was "ok" -- see rebuild.ts's doc comment on why it doesn't import
    // @pros/adapters itself. Re-parsing here is cheap and keeps this
    // package's event-shape knowledge in one place (the adapters package).
    const parsed: ParsedEvent = provider === "codex" ? parseCodexLine(row.raw_text, row.seq) : parseClaudeLine(row.raw_text, row.seq);

    if (parsed.parseStatus !== "ok" || parsed.data === undefined) {
      // Extremely unlikely (index and adapters disagreeing on parse_status
      // for the same line) but handled defensively rather than throwing.
      pushNode({
        id: nodeId,
        runId: row.run_id,
        attemptId: row.attempt_id,
        rawEventId: row.id,
        seq: row.seq,
        provider,
        kind: "unknown",
        label: "unknown (adapter/index parse_status mismatch)",
        detail: { rawTextPreview: truncate(row.raw_text, 120) },
      });
      continue;
    }

    const data = parsed.data as Record<string, unknown>;

    if (provider === "claude") {
      if (parsed.type === "assistant") {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
        let emittedAny = false;
        content.forEach((item, itemIdx) => {
          if (item["type"] !== "tool_use") return;
          emittedAny = true;
          const name = typeof item["name"] === "string" ? (item["name"] as string) : "unknown_tool";
          const input = (item["input"] ?? {}) as Record<string, unknown>;
          const { kind, label, detail } = describeClaudeToolUse({ name, input });
          const id = `${nodeId}:${itemIdx}`;
          pushNode({ id, runId: row.run_id, attemptId: row.attempt_id, rawEventId: row.id, seq: row.seq, provider, kind, label, detail });
          updateSummaryForToolUse(acc, name, input, kind);
          const toolUseId = typeof item["id"] === "string" ? (item["id"] as string) : undefined;
          if (toolUseId) pendingToolUse.set(toolUseId, id);
        });
        if (!emittedAny) {
          // An assistant turn with only text content (no tool_use): treated
          // as a prompt-boundary marker (our call -- documented above in
          // the brief as "your call, document it"). This keeps the plain
          // back-and-forth conversation visible in the graph instead of
          // vanishing entirely.
          const textItem = content.find((item) => item["type"] === "text");
          const text = textItem && typeof textItem["text"] === "string" ? (textItem["text"] as string) : "";
          pushNode({
            id: nodeId,
            runId: row.run_id,
            attemptId: row.attempt_id,
            rawEventId: row.id,
            seq: row.seq,
            provider,
            kind: "prompt",
            label: text ? `assistant: ${truncate(text)}` : "assistant turn",
            detail: { messageContent: content },
          });
        }
        continue;
      }

      if (parsed.type === "user") {
        const message = (data["message"] ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
        let emittedAny = false;
        content.forEach((item, itemIdx) => {
          if (item["type"] !== "tool_result") return;
          emittedAny = true;
          const toolUseId = typeof item["tool_use_id"] === "string" ? (item["tool_use_id"] as string) : undefined;
          const isError = item["is_error"] === true;
          const resultContent = item["content"];
          const label = isError
            ? `tool_result (error): ${truncate(typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent))}`
            : `tool_result: ${truncate(typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent))}`;
          const id = `${nodeId}:${itemIdx}`;
          pushNode({
            id,
            runId: row.run_id,
            attemptId: row.attempt_id,
            rawEventId: row.id,
            seq: row.seq,
            provider,
            kind: "tool_result",
            label,
            detail: { toolUseId, isError, content: resultContent },
          });
          if (toolUseId) {
            const callNodeId = pendingToolUse.get(toolUseId);
            if (callNodeId) edges.push({ from: callNodeId, to: id, kind: "tool_result_of" });
          }
        });
        if (!emittedAny) {
          // A plain user text turn (a new prompt): mark as a prompt-boundary
          // node -- these matter for teaching, since they're where a human
          // steered the session.
          const textItem = content.find((item) => item["type"] === "text");
          const text = textItem && typeof textItem["text"] === "string" ? (textItem["text"] as string) : typeof message["content"] === "string" ? (message["content"] as string) : "";
          pushNode({
            id: nodeId,
            runId: row.run_id,
            attemptId: row.attempt_id,
            rawEventId: row.id,
            seq: row.seq,
            provider,
            kind: "prompt",
            label: text ? `user: ${truncate(text)}` : "user turn",
            detail: { messageContent: content },
          });
        }
        continue;
      }

      if (parsed.type === "result") {
        // Final turn result: treated as a prompt-boundary marker (the
        // natural "end of this attempt's conversation" node), per the
        // brief's "your call, document it". Its `result` field is often the
        // most teaching-relevant one-line summary of the whole attempt.
        const resultText = typeof data["result"] === "string" ? (data["result"] as string) : "";
        pushNode({
          id: nodeId,
          runId: row.run_id,
          attemptId: row.attempt_id,
          rawEventId: row.id,
          seq: row.seq,
          provider,
          kind: "prompt",
          label: resultText ? `result: ${truncate(resultText)}` : "result",
          detail: { data },
        });
        continue;
      }

      // Recognized-but-unhandled claude types ("system", "rate_limit_event"):
      // not specifically modeled -- surfaced as "unknown" rather than
      // dropped (see the tolerant-parsing note at the top of this file).
      pushNode({
        id: nodeId,
        runId: row.run_id,
        attemptId: row.attempt_id,
        rawEventId: row.id,
        seq: row.seq,
        provider,
        kind: "unknown",
        label: `unhandled claude event: ${parsed.type}`,
        detail: { data },
      });
      continue;
    }

    // provider === "codex"
    if (parsed.type === "item.completed") {
      const item = (data["item"] ?? {}) as Record<string, unknown>;
      const itemType = typeof item["type"] === "string" ? (item["type"] as string) : undefined;

      if (itemType === "command_execution") {
        const command = typeof item["command"] === "string" ? (item["command"] as string) : "";
        pushNode({
          id: nodeId,
          runId: row.run_id,
          attemptId: row.attempt_id,
          rawEventId: row.id,
          seq: row.seq,
          provider,
          kind: "tool_call",
          label: `Bash: ${truncate(command)}`,
          detail: { tool: "Bash", item },
        });
        bumpTool(acc, "Bash");
        if (command) acc.bashVerbs.add(firstWord(command));
        continue;
      }

      if (itemType === "agent_message") {
        // Our call (documented in the brief as "your call"): treat a codex
        // agent_message as a prompt-boundary node -- it is the direct codex
        // analogue of a claude assistant text turn, and teaching-facing
        // value comes from seeing what the model said, not from hiding it.
        const text = typeof item["text"] === "string" ? (item["text"] as string) : "";
        pushNode({
          id: nodeId,
          runId: row.run_id,
          attemptId: row.attempt_id,
          rawEventId: row.id,
          seq: row.seq,
          provider,
          kind: "prompt",
          label: text ? `agent_message: ${truncate(text)}` : "agent_message",
          detail: { item },
        });
        continue;
      }

      // Any other item.completed item.type (e.g. reasoning, file_change,
      // mcp_tool_call, ...) not specifically modeled here yet: unknown, not
      // dropped.
      pushNode({
        id: nodeId,
        runId: row.run_id,
        attemptId: row.attempt_id,
        rawEventId: row.id,
        seq: row.seq,
        provider,
        kind: "unknown",
        label: `unhandled codex item type: ${itemType ?? "?"}`,
        detail: { item },
      });
      continue;
    }

    // Recognized-but-unhandled codex types ("thread.started", "turn.started",
    // "turn.completed", or any item.completed we didn't otherwise handle
    // above via early continue): unknown, not dropped.
    pushNode({
      id: nodeId,
      runId: row.run_id,
      attemptId: row.attempt_id,
      rawEventId: row.id,
      seq: row.seq,
      provider,
      kind: "unknown",
      label: `unhandled codex event: ${parsed.type}`,
      detail: { data },
    });
  }

  return {
    runId,
    nodes,
    edges,
    summary: {
      toolCounts: acc.toolCounts,
      subagentsSpawned: acc.subagentsSpawned,
      skillsInvoked: [...acc.skillsInvoked],
      filesWritten: [...acc.filesWritten],
      bashVerbs: [...acc.bashVerbs],
    },
  };
}
