import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Journal } from "@pros/barrier";

export type SessionActivityState = "working" | "done" | "error" | "info";

export interface SessionActivityItem {
  id: string;
  provider: "claude" | "codex" | "unknown";
  attemptId: string;
  seq: number;
  state: SessionActivityState;
  label: string;
  detail?: string;
  at: string;
}

export interface SessionActivitySnapshot {
  active: boolean;
  operation?: "plan_pipeline" | "codex_review" | "claude_refinement" | "implementation";
  operationLabel?: string;
  activity: SessionActivityItem[];
}

type Operation = NonNullable<SessionActivitySnapshot["operation"]>;

function operationLabel(operation: Operation): string {
  switch (operation) {
    case "plan_pipeline":
      return "Building a plan";
    case "codex_review":
      return "Reviewing the plan";
    case "claude_refinement":
      return "Refining the plan with Claude";
    case "implementation":
      return "Implementing the approved plan";
  }
}

function short(value: unknown, max = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Supports logs written by current adapters and the older prefixed format. */
function unwrapLogLine(line: string): string {
  const firstTab = line.indexOf("\t");
  const secondTab = firstTab === -1 ? -1 : line.indexOf("\t", firstTab + 1);
  if (firstTab === -1 || secondTab === -1) return line;
  const candidate = line.slice(secondTab + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return line;
  }
}

function providerFor(type: string | undefined, sidecar: string): SessionActivityItem["provider"] {
  if (sidecar === "claude" || sidecar === "codex") return sidecar;
  if (type?.startsWith("turn.") || type?.startsWith("thread.") || type === "item.completed") return "codex";
  if (type === "assistant" || type === "user" || type === "result" || type === "system" || type === "rate_limit_event") return "claude";
  return "unknown";
}

function claudeActivity(data: Record<string, unknown>): Pick<SessionActivityItem, "state" | "label" | "detail"> {
  const type = typeof data.type === "string" ? data.type : undefined;
  if (type === "result") {
    const isError = data.is_error === true;
    return { state: isError ? "error" : "done", label: isError ? "Claude reported an error" : "Claude finished this step", detail: short(data.result) };
  }
  if (type === "system") return { state: "info", label: "Claude session connected", detail: short(data.subtype) };
  if (type === "rate_limit_event") return { state: "info", label: "Claude is waiting for its usage limit", detail: short(data.message) };

  const message = jsonRecord(data.message);
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  const tool = content.find((item) => jsonRecord(item).type === "tool_use");
  if (tool) {
    const toolRecord = jsonRecord(tool);
    const name = typeof toolRecord.name === "string" ? toolRecord.name : "tool";
    const input = jsonRecord(toolRecord.input);
    if (name === "Task") {
      return { state: "working", label: "Claude is asking a subagent to investigate", detail: short(input.description ?? input.subagent_type) };
    }
    if (["Read", "Glob", "Grep", "LS"].includes(name)) {
      return { state: "working", label: "Claude is exploring the codebase", detail: short(input.file_path ?? input.pattern ?? input.path ?? input.query) };
    }
    if (name === "Bash") return { state: "working", label: "Claude is running a repository check", detail: short(input.command) };
    if (["Edit", "Write", "NotebookEdit"].includes(name)) {
      return { state: "working", label: "Claude is updating a file", detail: short(input.file_path ?? input.path) };
    }
    return { state: "working", label: `Claude is using ${name}`, detail: short(input.description ?? input.query) };
  }

  const text = content.map((item) => jsonRecord(item).text).find((item): item is string => typeof item === "string");
  if (type === "assistant") return { state: "working", label: "Claude is thinking through the result", detail: short(text) };
  if (type === "user") {
    const toolResult = content.find((item) => jsonRecord(item).type === "tool_result");
    return { state: jsonRecord(toolResult).is_error === true ? "error" : "info", label: "Claude received a tool result", detail: short(jsonRecord(toolResult).content) };
  }
  return { state: "info", label: "Claude sent an update" };
}

function codexActivity(data: Record<string, unknown>): Pick<SessionActivityItem, "state" | "label" | "detail"> {
  const type = typeof data.type === "string" ? data.type : undefined;
  if (type === "thread.started") return { state: "info", label: "Codex session connected" };
  if (type === "turn.started") return { state: "working", label: "Codex is starting its review" };
  if (type === "turn.completed") return { state: "done", label: "Codex finished its review" };
  if (type === "turn.failed") {
    const error = jsonRecord(data.error);
    return { state: "error", label: "Codex hit an error", detail: short(error.message ?? data.message ?? data.reason) };
  }
  if (type === "item.completed") {
    const item = jsonRecord(data.item);
    if (item.type === "command_execution") return { state: "working", label: "Codex is checking the repository", detail: short(item.command) };
    if (item.type === "agent_message") return { state: "working", label: "Codex is reviewing the plan", detail: short(item.text) };
  }
  return { state: "info", label: "Codex sent an update" };
}

function toActivity(raw: string, attemptId: string, seq: number, sidecar: string, at: string): SessionActivityItem {
  let data: Record<string, unknown> = {};
  try {
    data = jsonRecord(JSON.parse(unwrapLogLine(raw)));
  } catch {
    return { id: `${attemptId}:${seq}`, provider: "unknown", attemptId, seq, state: "error", label: "A session event could not be read", at };
  }
  const type = typeof data.type === "string" ? data.type : undefined;
  const provider = providerFor(type, sidecar);
  const description = provider === "codex" ? codexActivity(data) : claudeActivity(data);
  return { id: `${attemptId}:${seq}`, provider, attemptId, seq, at, ...description };
}

async function latestOperation(runDir: string): Promise<{ operation?: Operation; active: boolean }> {
  const { entries } = await Journal.read(runDir).catch(() => ({ entries: [] as Array<Record<string, unknown>> }));
  const entry = [...entries].reverse().find((item) => item.kind === "plan_operation_started" || item.kind === "plan_operation_completed") as Record<string, unknown> | undefined;
  const operation = entry?.operation as Operation | undefined;
  if (!operation) return { active: false };
  return { operation, active: entry?.kind === "plan_operation_started" };
}

export async function getSessionActivity(runDir: string): Promise<SessionActivitySnapshot> {
  const operation = await latestOperation(runDir);
  const attemptsDir = path.join(runDir, "attempts");
  const activity: Array<SessionActivityItem & { mtime: number }> = [];
  const attempts = await readdir(attemptsDir, { withFileTypes: true }).catch(() => []);
  for (const attempt of attempts) {
    if (!attempt.isDirectory()) continue;
    const attemptId = attempt.name;
    const attemptDir = path.join(attemptsDir, attemptId);
    const rawPath = path.join(attemptDir, "raw.log");
    const raw = await readFile(rawPath, "utf8").catch(() => "");
    if (!raw) continue;
    const sidecar = await readFile(path.join(attemptDir, "provider.txt"), "utf8").catch(() => "");
    const mtime = await stat(rawPath).then((value) => value.mtimeMs).catch(() => 0);
    let lines = raw.split("\n");
    if (raw.endsWith("\n")) lines = lines.slice(0, -1);
    lines.forEach((line, seq) => activity.push({ ...toActivity(line, attemptId, seq, sidecar.trim(), new Date(mtime).toISOString()), mtime }));
  }

  activity.sort((a, b) => a.mtime - b.mtime || a.seq - b.seq);
  return {
    active: operation.active,
    operation: operation.operation,
    operationLabel: operation.operation ? operationLabel(operation.operation) : undefined,
    activity: activity.slice(-32).map(({ mtime: _mtime, ...item }) => item),
  };
}
