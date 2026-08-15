export * from "./schema.js";
export * from "./rebuild.js";

import type Database from "better-sqlite3";

export interface PlanRow {
  id: number;
  run_id: string;
  plan_id: string;
  version: number;
  markdown: string;
  structured_json: string;
  state: string;
  unresolved_objections_json: string | null;
}

export interface ObjectionRow {
  id: number;
  plan_id: string;
  run_id: string;
  round: number;
  author: string;
  severity: string | null;
  claim: string | null;
  suggested_change: string | null;
  resolution: string | null;
}

/** All plan versions for a run, oldest first. Not exhaustive -- M2 doesn't build a UI, this is a convenience for tests/scripts. */
export function getPlans(db: Database.Database, runId: string): PlanRow[] {
  return db.prepare(`SELECT * FROM plans WHERE run_id = ? ORDER BY version ASC`).all(runId) as PlanRow[];
}

/** All objections raised against a given planId, oldest round first. */
export function getObjections(db: Database.Database, planId: string): ObjectionRow[] {
  return db.prepare(`SELECT * FROM objections WHERE plan_id = ? ORDER BY round ASC, id ASC`).all(planId) as ObjectionRow[];
}
