import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal } from "@pros/barrier";
import { rebuildIndex } from "../src/rebuild.js";
import { ALL_TABLES } from "../src/schema.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Dump a table's rows, excluding the autoincrement `id` column, in a deterministic order. */
function dumpTable(db: Database.Database, table: string, orderBy: string): unknown[] {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c !== "id");
  return db.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY ${orderBy}`).all();
}

test("rebuild: basic - findings, plans, objections, and raw_events are indexed with correct content", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbDir = await makeTempDir("pros-idx-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "finding_recorded", findingId: "f1", title: "Missing null check", evidenceJson: '{"file":"a.ts"}' });
    await j.append({ runId, fenceEpoch: 0, kind: "plan_drafted", planId: "p1", version: 1, markdown: "# plan v1", structuredJson: "{}" });
    await j.append({ runId, fenceEpoch: 0, kind: "critique_independent", planId: "p1", round: 1, assessmentJson: "{}" });
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "critique_objections",
      planId: "p1",
      round: 1,
      objectionsJson: JSON.stringify({
        objections: [
          { severity: "high", claim: "unsafe rm -rf", suggested_change: "add guard" },
          { severity: "low", claim: "typo in comment", suggested_change: "fix typo" },
        ],
      }),
    });
    await j.append({ runId, fenceEpoch: 0, kind: "plan_revised", planId: "p1", version: 2, markdown: "# plan v2", structuredJson: "{}", round: 1 });
    await j.append({ runId, fenceEpoch: 0, kind: "plan_finalized", planId: "p1", version: 2, unresolvedObjectionsJson: "[]" });
    await j.close();

    const attemptDir = path.join(runDir, "attempts", "att1");
    await mkdir(attemptDir, { recursive: true });
    await writeFile(attemptDir + "/provider.txt", "claude");
    const lines = [
      JSON.stringify({ type: "assistant", text: "hello" }),
      JSON.stringify({ type: "some_future_event", foo: "bar" }),
      "this is not json at all {",
    ];
    await writeFile(path.join(attemptDir, "raw.log"), lines.join("\n") + "\n");

    const dbPath = path.join(dbDir, "index.sqlite");
    const report = await rebuildIndex(dbPath, runsRoot);

    assert.equal(report.runsProcessed, 1);
    assert.deepEqual(report.truncatedRuns, []);
    assert.equal(report.findingsInserted, 1);
    assert.equal(report.plansInserted, 2);
    assert.equal(report.objectionsInserted, 2);
    assert.equal(report.rawEventsInserted, 3);

    const db = new Database(dbPath, { readonly: true });
    try {
      const findings = db.prepare("SELECT * FROM findings WHERE run_id = ?").all(runId) as any[];
      assert.equal(findings.length, 1);
      assert.equal(findings[0].title, "Missing null check");
      assert.equal(findings[0].evidence_json, '{"file":"a.ts"}');

      const plans = db.prepare("SELECT * FROM plans WHERE run_id = ? ORDER BY version").all(runId) as any[];
      assert.equal(plans.length, 2);
      assert.equal(plans[0].version, 1);
      assert.equal(plans[0].state, "drafted");
      assert.equal(plans[1].version, 2);
      assert.equal(plans[1].state, "finalized", "plan_finalized must update the version-2 row, not insert a third row");
      assert.equal(plans[1].unresolved_objections_json, "[]");

      const objections = db.prepare("SELECT * FROM objections WHERE plan_id = ? ORDER BY id").all("p1") as any[];
      assert.equal(objections.length, 2);
      assert.equal(objections[0].author, "codex");
      assert.equal(objections[0].severity, "high");
      assert.equal(objections[0].claim, "unsafe rm -rf");
      assert.equal(objections[1].severity, "low");

      const rawEvents = db.prepare("SELECT * FROM raw_events WHERE run_id = ? ORDER BY seq").all(runId) as any[];
      assert.equal(rawEvents.length, 3);
      assert.equal(rawEvents[0].parse_status, "ok");
      assert.equal(rawEvents[0].provider, "claude");
      assert.equal(rawEvents[1].parse_status, "unknown_type");
      assert.equal(rawEvents[2].parse_status, "malformed");
      assert.equal(rawEvents[2].raw_text, "this is not json at all {", "malformed lines must survive verbatim, never be dropped or mangled");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("rebuild: dedup - duplicate raw_events insert is a safe no-op, and re-running rebuildIndex is idempotent", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbDir = await makeTempDir("pros-idx-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId: "att1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();

    const attemptDir = path.join(runDir, "attempts", "att1");
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, "raw.log"), JSON.stringify({ type: "assistant", text: "hi" }) + "\n");

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);
    await rebuildIndex(dbPath, runsRoot); // re-run on unchanged data: must not double any row

    const db = new Database(dbPath, { readonly: false });
    try {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ?").get(runId) as any).n;
      assert.equal(count, 1, "re-running rebuildIndex on unchanged sources must not duplicate raw_events rows");

      // Directly exercise the UNIQUE(run_id, attempt_id, seq) + INSERT OR IGNORE
      // dedup mechanism itself, independent of the full-wipe rebuild strategy:
      // this is what protects against duplicate delivery of the same
      // (run_id, attempt_id, seq) triple within one pass over a raw.log.
      db.prepare(
        `INSERT OR IGNORE INTO raw_events (run_id, attempt_id, seq, ts, provider, cli_version, raw_text, parse_status)
         VALUES ('run1', 'att1', 0, '2020-01-01T00:00:00.000Z', 'claude', NULL, 'duplicate delivery of the same line', 'ok')`,
      ).run();
      const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ?").get(runId) as any).n;
      assert.equal(countAfter, 1, "UNIQUE(run_id, attempt_id, seq) + INSERT OR IGNORE must reject the duplicate (run_id, attempt_id, seq)");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("rebuild: a truncated/partial trailing raw.log line does not crash indexing and is recorded as malformed", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbDir = await makeTempDir("pros-idx-db-");
  try {
    const runId = "run2";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId: "attX", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();

    const attemptDir = path.join(runDir, "attempts", "attX");
    await mkdir(attemptDir, { recursive: true });
    const validLine = JSON.stringify({ type: "user", text: "go" });
    // No trailing newline after the partial fragment: simulates the process
    // being killed mid-write of the next line.
    const content = validLine + "\n" + '{"type":"assistant","text":"partial frag';
    await writeFile(path.join(attemptDir, "raw.log"), content);

    const dbPath = path.join(dbDir, "index.sqlite");
    const report = await rebuildIndex(dbPath, runsRoot); // must not throw

    assert.equal(report.runsProcessed, 1);
    assert.equal(report.rawEventsInserted, 2);

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT * FROM raw_events WHERE run_id = ? ORDER BY seq").all(runId) as any[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0].parse_status, "ok");
      assert.equal(rows[1].parse_status, "malformed");
      assert.equal(rows[1].raw_text, '{"type":"assistant","text":"partial frag', "the truncated fragment must be preserved verbatim, not dropped");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("rebuild: a torn journal tail is indexed up to the valid point and reported as truncated, not thrown", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbDir = await makeTempDir("pros-idx-db-");
  try {
    const runId = "run3";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_ended", attemptId: "a1", exitReason: "done" });
    await j.close();

    // Same torn-tail technique as packages/barrier/test/journal.test.ts's
    // kill-test #4: append a length prefix claiming more payload than
    // actually follows, as if the writer died mid-record.
    const journalPath = path.join(runDir, "journal.ndjson");
    const full = await readFile(journalPath);
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64BE(1000n);
    const withTornRecord = Buffer.concat([full, lenBuf, Buffer.from("short")]);
    await writeFile(journalPath, withTornRecord);

    const dbPath = path.join(dbDir, "index.sqlite");
    const report = await rebuildIndex(dbPath, runsRoot); // must not throw

    assert.deepEqual(report.truncatedRuns, [runId]);
    const db = new Database(dbPath, { readonly: true });
    try {
      const events = db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq").all(runId) as any[];
      assert.equal(events.length, 2, "the two valid pre-tear entries must still be indexed");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("index is fully rebuildable from the journal alone", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbPath = path.join(await makeTempDir("pros-idx-db-"), "index.sqlite");
  try {
    // Run A: worktree saga (intent -> allocated -> confirmed) plus a finding.
    const runA = "runA";
    const jA = await Journal.open(path.join(runsRoot, runA));
    await jA.append({ runId: runA, fenceEpoch: 0, kind: "worktree_intent", allocationId: "w1", repoRoot: "/repo", worktreePath: "/repo/.worktrees/w1", branch: "feat/w1" });
    await jA.append({ runId: runA, fenceEpoch: 0, kind: "worktree_allocated", allocationId: "w1", baseSha: "deadbeef", worktreePath: "/repo/.worktrees/w1", branch: "feat/w1" });
    await jA.append({ runId: runA, fenceEpoch: 0, kind: "worktree_confirmed", allocationId: "w1" });
    await jA.append({ runId: runA, fenceEpoch: 0, kind: "finding_recorded", findingId: "fA", title: "finding A", evidenceJson: "{}" });
    await jA.close();
    const attA = path.join(runsRoot, runA, "attempts", "a1");
    await mkdir(attA, { recursive: true });
    await writeFile(path.join(attA, "raw.log"), JSON.stringify({ type: "turn.started" }) + "\n" + "garbage\n");
    await writeFile(path.join(attA, "provider.txt"), "codex");

    // Run B: a plan that gets revised twice.
    const runB = "runB";
    const jB = await Journal.open(path.join(runsRoot, runB));
    await jB.append({ runId: runB, fenceEpoch: 0, kind: "plan_drafted", planId: "pB", version: 1, markdown: "v1", structuredJson: "{}" });
    await jB.append({ runId: runB, fenceEpoch: 0, kind: "plan_revised", planId: "pB", version: 2, markdown: "v2", structuredJson: "{}", round: 1 });
    await jB.append({ runId: runB, fenceEpoch: 0, kind: "debate_capped", planId: "pB", roundsRun: 2, reason: "max rounds" });
    await jB.close();

    // Run C: a worktree that gets rolled back.
    const runC = "runC";
    const jC = await Journal.open(path.join(runsRoot, runC));
    await jC.append({ runId: runC, fenceEpoch: 0, kind: "worktree_intent", allocationId: "w2", repoRoot: "/repo", worktreePath: "/repo/.worktrees/w2", branch: "feat/w2" });
    await jC.append({ runId: runC, fenceEpoch: 0, kind: "worktree_rollback", allocationId: "w2", reason: "base sha moved" });
    await jC.close();

    const report1 = await rebuildIndex(dbPath, runsRoot);
    assert.equal(report1.runsProcessed, 3);
    assert.deepEqual(report1.truncatedRuns, []);

    const dump1: Record<string, unknown[]> = {};
    const db1 = new Database(dbPath, { readonly: true });
    for (const table of ALL_TABLES) {
      if (table === "_index_meta") continue; // last_rebuild_at timestamp legitimately differs between runs
      const orderBy = table === "raw_events" ? "run_id, attempt_id, seq" : table === "objections" ? "run_id, plan_id, round, id" : "run_id, id";
      dump1[table] = dumpTable(db1, table, orderBy);
    }
    db1.close();

    const report2 = await rebuildIndex(dbPath, runsRoot); // rebuild again, from scratch, same inputs
    assert.equal(report2.runsProcessed, 3);
    assert.deepEqual(report2.truncatedRuns, []);

    const dump2: Record<string, unknown[]> = {};
    const db2 = new Database(dbPath, { readonly: true });
    for (const table of ALL_TABLES) {
      if (table === "_index_meta") continue;
      const orderBy = table === "raw_events" ? "run_id, attempt_id, seq" : table === "objections" ? "run_id, plan_id, round, id" : "run_id, id";
      dump2[table] = dumpTable(db2, table, orderBy);
    }
    db2.close();

    assert.deepEqual(dump2, dump1, "rebuilding from the journal + raw logs alone must reproduce byte-identical index contents");

    // Sanity: the worktree/plan rollups actually reflect final saga state.
    const db3 = new Database(dbPath, { readonly: true });
    try {
      const w1 = db3.prepare("SELECT * FROM worktrees WHERE run_id = ? AND allocation_id = ?").get(runA, "w1") as any;
      assert.equal(w1.state, "confirmed");
      assert.equal(w1.base_sha, "deadbeef");

      const w2 = db3.prepare("SELECT * FROM worktrees WHERE run_id = ? AND allocation_id = ?").get(runC, "w2") as any;
      assert.equal(w2.state, "rolled_back");
      assert.equal(w2.reason, "base sha moved");

      const plansB = db3.prepare("SELECT * FROM plans WHERE run_id = ? ORDER BY version").all(runB) as any[];
      assert.equal(plansB.length, 2);
      assert.equal(plansB[1].state, "revised");
    } finally {
      db3.close();
    }
  } finally {
    await cleanup(runsRoot);
  }
});

// ---------------------------------------------------------------------------
// Phase 3: validation_command_run -> validation_checks
// ---------------------------------------------------------------------------

test("rebuild: validation_command_run journal entries project into validation_checks with exit codes preserved", async () => {
  const runsRoot = await makeTempDir("pros-idx-runs-");
  const dbDir = await makeTempDir("pros-idx-db-");
  try {
    const runId = "run-vcr";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    // Same tolerant, off-union `as any` write pipeline.ts itself uses for
    // this event kind (it isn't a member of @pros/barrier's JournalEntry
    // union -- see pipeline.ts's file doc comment).
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "validation_command_run",
      attemptId: `${runId}-verify`,
      command: "pnpm run typecheck",
      label: "typecheck",
      role: "gate",
      exitCode: 0,
      timedOut: false,
      durationMs: 1234,
      outputTail: "tsc found no errors",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await j.append({
      runId,
      fenceEpoch: 0,
      kind: "validation_command_run",
      attemptId: `${runId}-verify`,
      command: "pnpm run test",
      label: "test",
      role: "gate",
      exitCode: 1,
      timedOut: false,
      durationMs: 5678,
      outputTail: "1 failing",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await j.close();

    const dbPath = path.join(dbDir, "index.sqlite");
    const report = await rebuildIndex(dbPath, runsRoot);
    assert.equal(report.validationChecksInserted, 2);

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT * FROM validation_checks WHERE run_id = ? ORDER BY seq").all(runId) as any[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0].command, "pnpm run typecheck");
      assert.equal(rows[0].exit_code, 0);
      assert.equal(rows[0].timed_out, 0);
      assert.equal(rows[1].command, "pnpm run test");
      assert.equal(rows[1].exit_code, 1);
      assert.equal(rows[1].output_tail, "1 failing");

      // Also captured generically in `events` (payload_json), same as every other kind -- validation_checks is additive, not a replacement.
      const eventsRows = db.prepare("SELECT kind FROM events WHERE run_id = ? AND kind = 'validation_command_run'").all(runId) as any[];
      assert.equal(eventsRows.length, 2);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
  }
});
