import { randomUUID } from "node:crypto";
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

export async function runFinding(session: ModelSession, opts: RunFindingOptions): Promise<Finding> {
  const result = await session.run({
    cwd: opts.cwd,
    prompt: buildFindingPrompt(opts.description),
    schema: FINDING_SCHEMA,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    rawLogPath: opts.rawLogPath,
    attemptId: opts.attemptId,
  });
  const parsed = parseFinding(result.text);
  return { findingId: randomUUID(), ...parsed, sessionId: result.sessionId };
}
