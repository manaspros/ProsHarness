import { randomUUID } from "node:crypto";
import type { ModelSession } from "./model-session.js";
import type { Finding } from "./finding.js";
import type { Objection } from "./critique.js";
import { DEFAULT_SESSION_DIRECTIVE } from "./session-directive.js";

export interface PlanDoc {
  planId: string;
  version: number;
  markdown: string;
  structured: unknown;
  /** The Claude session that produced this version, when the provider returned one. */
  sessionId?: string;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    markdown: { type: "string" },
    structured: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" } },
        filesTouched: { type: "array", items: { type: "string" } },
        risk: { type: "string" },
      },
      required: ["steps", "filesTouched", "risk"],
    },
  },
  required: ["markdown", "structured"],
} as const;

function parsePlanResponse(text: string, context: string): { markdown: string; structured: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${context}: model output was not valid JSON: ${(err as Error).message}\n--- raw output ---\n${text}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj?.markdown !== "string" || typeof obj?.structured !== "object" || obj.structured === null) {
    throw new Error(`${context}: malformed plan response, expected {markdown: string, structured: object}\n--- raw output ---\n${text}`);
  }
  return { markdown: obj.markdown, structured: obj.structured };
}

function findingBlock(finding: Finding): string {
  const evidence = finding.evidence.map((e) => `  - ${e.file}:${e.line} -- ${e.snippet}`).join("\n");
  return [
    `Title: ${finding.title}`,
    `Summary: ${finding.summary}`,
    `Evidence:`,
    evidence,
  ].join("\n");
}

export interface DraftPlanOptions {
  cwd: string;
  finding: Finding;
  attemptId: string;
  /** Optional Claude session to resume. Defaults to the session on `finding`. */
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  rawLogPath?: string;
}

/** Draft the first version (v1) of a plan addressing `opts.finding`. */
export async function draftPlan(session: ModelSession, opts: DraftPlanOptions): Promise<PlanDoc> {
  const prompt = [
    "You are drafting an implementation plan to fix/address the following finding, in the repository at the current working directory.",
    "Use your own tools to read the relevant code before proposing changes.",
    "",
    DEFAULT_SESSION_DIRECTIVE,
    "",
    findingBlock(opts.finding),
    "",
    "Conclude with a single JSON object (matching the provided schema) with:",
    '  - "markdown": a human-readable plan (steps, rationale, risk) in Markdown',
    '  - "structured": {steps: string[], filesTouched: string[], risk: string} summarizing the same plan',
  ].join("\n");

  const result = await session.run({
    cwd: opts.cwd,
    prompt,
    schema: PLAN_SCHEMA,
    resumeSessionId: opts.resumeSessionId ?? opts.finding.sessionId,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    rawLogPath: opts.rawLogPath,
    attemptId: opts.attemptId,
  });
  const { markdown, structured } = parsePlanResponse(result.text, "draftPlan");
  return {
    planId: randomUUID(),
    version: 1,
    markdown,
    structured,
    sessionId: result.sessionId ?? opts.resumeSessionId ?? opts.finding.sessionId,
  };
}

export interface RevisePlanOptions {
  cwd: string;
  finding: Finding;
  previous: PlanDoc;
  objections: Objection[];
  attemptId: string;
  /** Optional Claude session to resume. Defaults to the session on `previous`. */
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  rawLogPath?: string;
}

/**
 * Revise a plan to (as the model determines) address a set of objections.
 * The model is instructed to say, per objection, whether it accepted or
 * rejected the suggested change and why -- `debate.ts` reads that back out
 * of `structured.objectionResolutions` to set each `Objection.resolution`.
 */
export async function revisePlan(session: ModelSession, opts: RevisePlanOptions): Promise<PlanDoc> {
  const objectionsBlock = opts.objections
    .map(
      (o, i) =>
        `  ${i + 1}. [${o.severity}] ${o.claim}\n     suggested change: ${o.suggested_change}`,
    )
    .join("\n");

  const prompt = [
    "You previously drafted the following plan to address a finding:",
    "",
    DEFAULT_SESSION_DIRECTIVE,
    "",
    `--- previous plan (version ${opts.previous.version}) ---`,
    opts.previous.markdown,
    "",
    "An independent reviewer (Codex) raised these objections against it:",
    objectionsBlock,
    "",
    "For EACH objection, either incorporate the suggested change into your revised plan, or explicitly explain why you",
    "are rejecting it. Then produce a revised plan.",
    "",
    "Conclude with a single JSON object (matching the provided schema) with:",
    '  - "markdown": the revised human-readable plan in Markdown, INCLUDING a short "Objection responses" section',
    "    listing each objection's claim and whether you accepted or rejected it and why",
    '  - "structured": {steps: string[], filesTouched: string[], risk: string,',
    '    objectionResolutions: {claim: string, resolution: "accepted"|"rejected", note: string}[]}',
    "",
    findingBlock(opts.finding),
  ].join("\n");

  const revisePlanSchema = {
    type: "object",
    properties: {
      markdown: { type: "string" },
      structured: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" } },
          filesTouched: { type: "array", items: { type: "string" } },
          risk: { type: "string" },
          objectionResolutions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                resolution: { type: "string", enum: ["accepted", "rejected"] },
                note: { type: "string" },
              },
              required: ["claim", "resolution"],
            },
          },
        },
        required: ["steps", "filesTouched", "risk", "objectionResolutions"],
      },
    },
    required: ["markdown", "structured"],
  } as const;

  const result = await session.run({
    cwd: opts.cwd,
    prompt,
    schema: revisePlanSchema,
    resumeSessionId: opts.resumeSessionId ?? opts.previous.sessionId,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    rawLogPath: opts.rawLogPath,
    attemptId: opts.attemptId,
  });
  const { markdown, structured } = parsePlanResponse(result.text, "revisePlan");
  return {
    planId: opts.previous.planId,
    version: opts.previous.version + 1,
    markdown,
    structured,
    sessionId: result.sessionId ?? opts.resumeSessionId ?? opts.previous.sessionId,
  };
}

export interface RefinePlanOptions {
  cwd: string;
  finding: Finding;
  previous: PlanDoc;
  instruction: string;
  attemptId: string;
  /** Optional Claude session to resume. Defaults to the session on `previous`. */
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  rawLogPath?: string;
}

/** Apply a human instruction to the current plan while preserving its Claude context. */
export async function refinePlanWithInstruction(session: ModelSession, opts: RefinePlanOptions): Promise<PlanDoc> {
  const prompt = [
    "Refine the current implementation plan in response to this user's instruction.",
    "Continue investigating the repository with your tools as needed, but do not implement code yet.",
    "",
    DEFAULT_SESSION_DIRECTIVE,
    "",
    `--- current plan (version ${opts.previous.version}) ---`,
    opts.previous.markdown,
    "",
    "--- user instruction ---",
    opts.instruction,
    "",
    "--- original finding ---",
    findingBlock(opts.finding),
    "",
    "Conclude with a single JSON object (matching the provided schema) with:",
    '  - "markdown": the updated human-readable plan in Markdown',
    '  - "structured": {steps: string[], filesTouched: string[], risk: string}',
  ].join("\n");

  const result = await session.run({
    cwd: opts.cwd,
    prompt,
    schema: PLAN_SCHEMA,
    resumeSessionId: opts.resumeSessionId ?? opts.previous.sessionId,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    rawLogPath: opts.rawLogPath,
    attemptId: opts.attemptId,
  });
  const { markdown, structured } = parsePlanResponse(result.text, "refinePlanWithInstruction");
  return {
    planId: opts.previous.planId,
    version: opts.previous.version + 1,
    markdown,
    structured,
    sessionId: result.sessionId ?? opts.resumeSessionId ?? opts.previous.sessionId,
  };
}
