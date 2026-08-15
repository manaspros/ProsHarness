import type { ModelSession } from "./model-session.js";
import type { Finding } from "./finding.js";
import type { PlanDoc } from "./plan.js";

export type Severity = "blocker" | "major" | "minor";

export interface Objection {
  severity: Severity;
  claim: string;
  suggested_change: string;
  resolution?: "accepted" | "rejected" | "unresolved";
}

const ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    approach: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["approach", "risks"],
} as const;

// Verified-working shape against BOTH real CLIs in M0 (docs/01-m0-results.md)
// -- field names are load-bearing, do not rename.
const OBJECTIONS_SCHEMA = {
  type: "object",
  properties: {
    objections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          claim: { type: "string" },
          suggested_change: { type: "string" },
        },
        required: ["severity", "claim", "suggested_change"],
      },
    },
  },
  required: ["objections"],
} as const;

function findingBlock(finding: Finding): string {
  const evidence = finding.evidence.map((e) => `  - ${e.file}:${e.line} -- ${e.snippet}`).join("\n");
  return [`Title: ${finding.title}`, `Summary: ${finding.summary}`, `Evidence:`, evidence].join("\n");
}

export interface IndependentAssessmentOptions {
  cwd: string;
  finding: Finding;
  attemptId: string;
}

/**
 * Independence is the whole point: Codex sees ONLY the finding + its own
 * repo access here, NEVER Claude's plan text. Per docs/03-architecture.md:
 * "If Codex is handed Claude's plan as its only input, it critiques
 * wording. It must read the repo and the finding itself."
 */
export async function independentAssessment(
  codexSession: ModelSession,
  opts: IndependentAssessmentOptions,
): Promise<{ assessment: unknown }> {
  const prompt = [
    "Independently investigate the following finding in the repository at the current working directory, using your own",
    "tools. Form your OWN opinion on how you would approach fixing it -- you have not been shown anyone else's plan.",
    "",
    findingBlock(opts.finding),
    "",
    "Conclude with a single JSON object (matching the provided schema) with:",
    '  - "approach": a short description of how you would approach a fix',
    '  - "risks": an array of specific risks/edge cases you would want any implementation plan to address',
  ].join("\n");

  const result = await codexSession.run({ cwd: opts.cwd, prompt, schema: ASSESSMENT_SCHEMA, attemptId: opts.attemptId });
  let assessment: unknown;
  try {
    assessment = JSON.parse(result.text);
  } catch (err) {
    throw new Error(`independentAssessment: model output was not valid JSON: ${(err as Error).message}\n--- raw output ---\n${result.text}`);
  }
  return { assessment };
}

export interface CritiqueObjectionsOptions {
  cwd: string;
  finding: Finding;
  independentAssessment: unknown;
  plan: PlanDoc;
  /** Round 2+: re-attack ONLY these previously-unresolved objections, not fresh ones. */
  unresolvedOnly?: Objection[];
  attemptId: string;
}

/**
 * Give Codex both its own independent assessment (so it argues FROM its own
 * prior view) and Claude's actual plan, and ask it to critique.
 *
 * On enforcing "re-attack only unresolved items" (round 2+): the prompt
 * explicitly instructs the model to restrict itself to the given list and
 * NOT invent fresh objections, but a real model can still ignore that
 * instruction. We do not filter/drop whatever the model returns -- silently
 * discarding a legitimate new blocker the model found while re-reading the
 * revised plan would be worse than tolerating one round where "unresolved
 * only" is advisory rather than enforced. This is a documented gap, not an
 * oversight -- see docs/05-m2-implementation-log.md.
 */
export async function critiqueObjections(codexSession: ModelSession, opts: CritiqueObjectionsOptions): Promise<Objection[]> {
  const parts = [
    "You previously formed this independent assessment of how to approach the finding below:",
    JSON.stringify(opts.independentAssessment, null, 2),
    "",
    "Another engineer (Claude) has now proposed the following plan:",
    "",
    `--- plan (version ${opts.plan.version}) ---`,
    opts.plan.markdown,
    "",
  ];

  if (opts.unresolvedOnly && opts.unresolvedOnly.length > 0) {
    parts.push(
      "This is a follow-up round. Re-attack ONLY the following previously-unresolved objections -- do not raise fresh",
      "objections unless the revised plan has introduced a genuinely new, serious problem:",
      opts.unresolvedOnly.map((o, i) => `  ${i + 1}. [${o.severity}] ${o.claim}`).join("\n"),
      "",
    );
  } else {
    parts.push(
      "Critique this plan against your own independent assessment and against the finding/repo directly. Raise any",
      "objections you have.",
      "",
    );
  }

  parts.push(
    findingBlock(opts.finding),
    "",
    'Conclude with a single JSON object (matching the provided schema): {"objections":[{"severity":"blocker|major|minor",',
    '"claim":"...","suggested_change":"..."}]}. If you have no objections, return an empty array.',
  );

  const result = await codexSession.run({
    cwd: opts.cwd,
    prompt: parts.join("\n"),
    schema: OBJECTIONS_SCHEMA,
    attemptId: opts.attemptId,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch (err) {
    throw new Error(`critiqueObjections: model output was not valid JSON: ${(err as Error).message}\n--- raw output ---\n${result.text}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.objections)) {
    throw new Error(`critiqueObjections: malformed response, expected {objections: [...]}\n--- raw output ---\n${result.text}`);
  }
  return (obj.objections as unknown[]).map((o, i) => {
    const rec = o as Record<string, unknown>;
    if (
      typeof rec.severity !== "string" ||
      !["blocker", "major", "minor"].includes(rec.severity) ||
      typeof rec.claim !== "string" ||
      typeof rec.suggested_change !== "string"
    ) {
      throw new Error(`critiqueObjections: malformed objection at index ${i}: ${JSON.stringify(o)}`);
    }
    return {
      severity: rec.severity as Severity,
      claim: rec.claim,
      suggested_change: rec.suggested_change,
      resolution: "unresolved" as const,
    };
  });
}
