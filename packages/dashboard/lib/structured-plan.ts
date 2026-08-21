/**
 * structured-plan.ts -- typed, defensive access to `PlanDoc.structured`
 * (packages/plan/src/plan.ts), which is stored on disk and in SQLite
 * (`plans.structured_json`) as `unknown` JSON.
 *
 * B6 (see the phase brief): the plan pipeline already produces
 * `{steps, filesTouched, risk}` and it already reaches SQLite, but the
 * Gate 1 page's TypeScript type for `current` omitted `structured` from its
 * shape entirely, so it never reached the page at all. This file is the
 * single, tested place that turns the raw JSON text back into a plan
 * decision-card can render safely.
 *
 * `diagram` and `claim` are new fields (this phase). Every run drafted
 * before this change has neither -- parsing must degrade gracefully for
 * those old runs (undefined, never a thrown error or a broken box), while
 * still requiring the older `steps`/`filesTouched`/`risk` fields since
 * those have been part of the schema since M2.
 */

export interface StructuredPlan {
  steps: string[];
  filesTouched: string[];
  risk: string;
  /** Mermaid diagram source. Absent for runs drafted before this phase, or if the model omitted it. */
  diagram?: string;
  /** Plain-language, one-paragraph restatement of what this plan claims to do. Same graceful-absence rule as `diagram`. */
  claim?: string;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Trims and drops empty strings -- an empty diagram/claim string is functionally the same as an absent one for rendering purposes. */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses a `plans.structured_json` column value into a `StructuredPlan`.
 * Returns `undefined` -- never throws -- for null/missing/malformed input,
 * so a caller can render an honest "no structured plan recorded" state
 * instead of crashing the page or a broken box.
 */
export function parseStructuredPlan(structuredJson: string | null | undefined): StructuredPlan | undefined {
  if (!structuredJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(structuredJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    steps: asStringArray(obj.steps),
    filesTouched: asStringArray(obj.filesTouched),
    risk: typeof obj.risk === "string" ? obj.risk : "",
    diagram: asNonEmptyString(obj.diagram),
    claim: asNonEmptyString(obj.claim),
  };
}
