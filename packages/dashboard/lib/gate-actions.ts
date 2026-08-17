/**
 * Pure logic: map a plan-approval button click (Approve / Reject) to the
 * AnswerEffect that `Barrier.recordAnswer` must be called
 * with. Kept out of the route handler so it's independently unit-testable
 * (per the brief: "map an AnswerEffect button click to the right
 * recordAnswer args").
 */
import type { AnswerEffect } from "@pros/barrier";

export type PlanApprovalAction = "approve" | "reject";

export const PLAN_APPROVAL_ACTIONS: PlanApprovalAction[] = ["approve", "reject"];

export function planActionToEffect(action: PlanApprovalAction): AnswerEffect {
  switch (action) {
    case "approve":
      return "continue_within_approved_plan";
    case "reject":
      return "abort";
    default: {
      // Exhaustiveness guard -- if PlanApprovalAction ever grows a member
      // without a corresponding case above, this is a compile error, not a
      // silent runtime fallback.
      const _exhaustive: never = action;
      throw new Error(`unhandled plan approval action: ${_exhaustive}`);
    }
  }
}

/** Default effect for the free-form Questions page (ask_human gate), per the brief. */
export const DEFAULT_ANSWER_EFFECT: AnswerEffect = "continue_within_approved_plan";

export const ANSWER_EFFECTS: AnswerEffect[] = ["continue_within_approved_plan", "requires_plan_amendment", "abort"];

export function isAnswerEffect(value: string): value is AnswerEffect {
  return (ANSWER_EFFECTS as string[]).includes(value);
}
