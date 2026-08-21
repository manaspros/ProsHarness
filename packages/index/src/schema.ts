/**
 * SQL schema for the rebuildable SQLite index (M2).
 *
 * SQLite is a *derived* index over the on-disk journal + raw attempt logs --
 * it holds no information that cannot be recomputed from those sources
 * (docs/03-architecture.md, "Durability model"). Every table here mirrors
 * either a JournalEntry kind or a raw.log line; nothing is invented here.
 *
 * Table shapes mostly match the architecture doc verbatim. Additions beyond
 * the doc, documented as we go:
 *   - `events`: a generic catch-all with one row per JournalEntry, so the
 *     index is queryable by `kind` without a bespoke table per kind. The
 *     doc's `events(id, run_id, raw_event_id, kind, role, tool_name,
 *     payload_json, is_unknown)` shape was written with *raw provider
 *     events* (from raw.log) in mind, not journal entries -- but the same
 *     shape is reusable: for journal-derived rows there is no raw_event_id
 *     (journal entries aren't raw provider output), so it's nullable here,
 *     and role/tool_name are nullable too since most JournalEntry kinds
 *     don't have either concept. is_unknown is always 0 for these rows: the
 *     journal is our own well-typed schema, so "unknown" only applies to
 *     raw_events sourced from attempts/<attemptId>/raw.log.
 *   - `validation_checks`: one row per Phase 3 `validation_command_run`
 *     journal entry (packages/implement's verify.ts/pipeline.ts) -- the
 *     harness-recorded exit code/duration/output-tail evidence a verdict was
 *     derived from. Not in the architecture doc (predates M4's verify
 *     rewrite); added the same way `worktrees` was, as a dedicated table
 *     alongside the generic `events` catch-all so a decision-card UI can
 *     query "every check for this run/attempt" without parsing JSON.
 *   - `worktrees`: not spelled out in the architecture doc's table list; the
 *     doc only says the worktree saga's journal entries exist. Derived
 *     reasonably from packages/barrier/src/types.ts's
 *     worktree_intent/allocated/confirmed/rollback shapes.
 *   - `_index_meta`: internal bookkeeping (last rebuild time, counts),
 *     not part of the architecture doc's authoritative table list -- purely
 *     an implementation convenience for this package.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  cli_version TEXT,
  raw_text TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  UNIQUE(run_id, attempt_id, seq)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  raw_event_id INTEGER,
  kind TEXT NOT NULL,
  role TEXT,
  tool_name TEXT,
  payload_json TEXT NOT NULL,
  is_unknown INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  state TEXT NOT NULL,
  unresolved_objections_json TEXT,
  edited_at TEXT,
  edited_by TEXT,
  UNIQUE(run_id, version)
);

CREATE TABLE IF NOT EXISTS objections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  author TEXT NOT NULL,
  severity TEXT,
  claim TEXT,
  suggested_change TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  UNIQUE(run_id, finding_id)
);

CREATE TABLE IF NOT EXISTS validation_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  command TEXT NOT NULL,
  label TEXT,
  role TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  timed_out INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  output_tail TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS worktrees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  repo_root TEXT,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  fence_epoch INTEGER,
  state TEXT NOT NULL,
  reason TEXT,
  UNIQUE(run_id, allocation_id)
);

CREATE TABLE IF NOT EXISTS _index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** All tables owned by this package, in an order safe for DROP (no FK constraints, so any order works). */
export const ALL_TABLES = [
  "raw_events",
  "events",
  "plans",
  "objections",
  "findings",
  "validation_checks",
  "worktrees",
  "_index_meta",
] as const;
