import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelSession } from "./model-session.js";
import { DEFAULT_SESSION_DIRECTIVE } from "./session-directive.js";

export interface FindingEvidence {
  file: string;
  line: number;
  snippet: string;
}

export interface Finding {
  findingId: string;
  title: string;
  evidence: FindingEvidence[];
  summary: string;
  /** The Claude session that produced this finding, when available. */
  sessionId?: string;
}

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          snippet: { type: "string" },
        },
        required: ["file", "line", "snippet"],
      },
    },
    summary: { type: "string" },
  },
  required: ["title", "evidence", "summary"],
} as const;

export interface RunFindingOptions {
  cwd: string;
  description: string;
  attemptId: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs?: number;
  rawLogPath?: string;
}

function buildFindingPrompt(description: string): string {
  return [
    "You are investigating a bug/task in the repository at the current working directory.",
    "Use your own tools (reading files, grepping, etc.) to locate the root cause.",
    "",
    DEFAULT_SESSION_DIRECTIVE,
    "",
    `Task description: ${description}`,
    "",
    "Conclude with a single JSON object (matching the provided schema) with:",
    '  - "title": a short one-line title for the finding',
    '  - "evidence": an array of {file, line, snippet} objects, each citing a REAL file path (relative to the repo root)',
    "    and 1-based line number that a reader could open and see the snippet at -- this is checked, do not guess or",
    "    fabricate a file/line you have not actually read.",
    '  - "summary": a few-sentence explanation of the root cause',
  ].join("\n");
}

/**
 * Never silently swallow a malformed finding -- same tolerant-parsing
 * philosophy as @pros/adapters, applied to structured model output: a
 * finding that doesn't parse or doesn't match the required shape is a loud,
 * specific error, not an empty/garbage Finding.
 */
function parseFinding(text: string): Omit<Finding, "findingId"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`runFinding: model output was not valid JSON: ${(err as Error).message}\n--- raw output ---\n${text}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`runFinding: expected a JSON object, got ${typeof parsed}`);
  }
  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.title !== "string") missing.push("title (string)");
  if (typeof obj.summary !== "string") missing.push("summary (string)");
  if (!Array.isArray(obj.evidence)) {
    missing.push("evidence (array)");
  } else {
    obj.evidence.forEach((e, i) => {
      if (typeof e !== "object" || e === null) {
        missing.push(`evidence[${i}] (object)`);
        return;
      }
      const ev = e as Record<string, unknown>;
      if (typeof ev.file !== "string") missing.push(`evidence[${i}].file (string)`);
      if (typeof ev.line !== "number") missing.push(`evidence[${i}].line (number)`);
      if (typeof ev.snippet !== "string") missing.push(`evidence[${i}].snippet (string)`);
    });
  }
  if (missing.length > 0) {
    throw new Error(`runFinding: malformed finding, missing/invalid fields: ${missing.join(", ")}\n--- raw output ---\n${text}`);
  }
  return {
    title: obj.title as string,
    evidence: obj.evidence as FindingEvidence[],
    summary: obj.summary as string,
  };
}

async function validateFindingEvidence(cwd: string, evidence: FindingEvidence[]): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = await realpath(cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`runFinding: repository path ${cwd} is not accessible: ${reason}`);
  }

  for (const [index, item] of evidence.entries()) {
    if (item.file.trim().length === 0) {
      throw new Error(`runFinding: evidence[${index}].file must not be empty`);
    }
    if (path.isAbsolute(item.file)) {
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} must be relative to repository ${repoRoot}`);
    }
    if (!Number.isInteger(item.line) || item.line < 1) {
      throw new Error(`runFinding: evidence[${index}].line must be a positive integer`);
    }
    if (item.snippet.length === 0) {
      throw new Error(`runFinding: evidence[${index}].snippet must not be empty`);
    }

    const candidate = path.resolve(repoRoot, item.file);
    let resolvedFile: string;
    try {
      resolvedFile = await realpath(candidate);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} does not exist: ${reason}`);
    }
    const relative = path.relative(repoRoot, resolvedFile);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} is outside repository ${repoRoot}`);
    }

    let fileStat;
    try {
      fileStat = await stat(resolvedFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} is not readable: ${reason}`);
    }
    if (!fileStat.isFile()) {
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} is not a regular file`);
    }

    let source: string;
    try {
      source = await readFile(resolvedFile, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`runFinding: evidence[${index}].file ${JSON.stringify(item.file)} is not readable: ${reason}`);
    }
    const lines = source.split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") lines.pop();
    if (item.line > lines.length) {
      throw new Error(
        `runFinding: evidence[${index}] line ${item.line} is outside ${JSON.stringify(item.file)} (line count: ${lines.length})`,
      );
    }
    if (!lines[item.line - 1]!.includes(item.snippet)) {
      throw new Error(
        `runFinding: evidence[${index}] snippet does not occur on ${JSON.stringify(item.file)}:${item.line}`,
      );
    }
  }
}

export async function runFinding(session: ModelSession, opts: RunFindingOptions): Promise<Finding> {
  const result = await session.run({
    cwd: opts.cwd,
    prompt: buildFindingPrompt(opts.description),
    schema: FINDING_SCHEMA,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    timeoutMs: opts.timeoutMs,
    rawLogPath: opts.rawLogPath,
    attemptId: opts.attemptId,
  });
  const parsed = parseFinding(result.text);
  await validateFindingEvidence(opts.cwd, parsed.evidence);
  return { findingId: randomUUID(), ...parsed, sessionId: result.sessionId };
}
