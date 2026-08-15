/**
 * Pure logic: "which markdown counts as the current plan version's text
 * given a list of PlanRows" (this file's whole reason for existing, per the
 * brief).
 *
 * Why picking "the highest version row" is sufficient, and does not need to
 * special-case plan_edited separately: packages/index/src/rebuild.ts's
 * `plan_edited` handling mutates the SAME PlanState keyed by `version`
 * in-place (`existing.markdown = entry.markdown`) rather than minting a new
 * version. So a plan row's `markdown` column already reflects the latest
 * edit for that version, if any -- `edited_at`/`edited_by` are non-null
 * exactly when that happened, and are surfaced for display, but the row's
 * `markdown` is already resolved correctly whether or not an edit occurred.
 * "Current" therefore reduces to: the row with the highest `version` for
 * this run.
 */
export interface PlanRowLike {
  version: number;
  markdown: string;
  plan_id: string;
  state: string;
  edited_at: string | null;
  edited_by: string | null;
}

export function resolveCurrentPlan<T extends PlanRowLike>(plans: T[]): T | undefined {
  if (plans.length === 0) return undefined;
  return plans.reduce((latest, p) => (p.version > latest.version ? p : latest), plans[0]!);
}
