import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Journal } from "@pros/barrier";
import { rebuildIndex } from "@pros/index";
import { buildSessionGraph } from "../src/graph.js";
import type { SessionGraph } from "../src/graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Pull the two real fixture lines we need (a Bash tool_use, and its matching
 * tool_result) straight out of packages/adapters' real recorded fixture, by
 * content-matching on the JSON shape rather than a hardcoded line number --
 * copy the pattern already used by packages/index/test/rebuild.test.ts of
 * building fixture raw.log content, but source the *content* itself from a
 * real recorded transcript instead of hand-writing synthetic JSON, per the
 * brief's instruction to use REAL lines for the headline test.
 */
function loadRealClaudeToolCallLines(): { toolUseLine: string; toolResultLine: string } {
  const fixturePath = path.join(
    __dirname,
    "../../adapters/test/fixtures/claude/claude-tool-call.ndjson",
  );
  const raw = readFileSync(fixturePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let toolUseLine: string | undefined;
  let toolResultLine: string | undefined;
  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!toolUseLine && obj.type === "assistant" && Array.isArray(obj.message?.content) && obj.message.content.some((c: any) => c.type === "tool_use")) {
      toolUseLine = line;
    }
    if (!toolResultLine && obj.type === "user" && Array.isArray(obj.message?.content) && obj.message.content.some((c: any) => c.type === "tool_result")) {
      toolResultLine = line;
    }
  }
  if (!toolUseLine || !toolResultLine) {
    throw new Error("fixture file did not contain expected assistant tool_use / user tool_result lines");
  }
  return { toolUseLine, toolResultLine };
}

/** Builds a minimal realistic run (journal + one attempt's raw.log) under runsRoot, matching the exact fixture-building pattern used by packages/index/test/rebuild.test.ts (Journal.open/append/close, then a hand-written attempts/<id>/raw.log + provider.txt). */
async function buildRealisticRun(runsRoot: string, runId: string, attemptId: string, rawLogLines: string[]): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  const j = await Journal.open(runDir);
  await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId, cwd: "/x", launchConfigHash: "h", unitName: "u" });
  await j.close();

  const attemptDir = path.join(runDir, "attempts", attemptId);
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "provider.txt"), "claude");
  await writeFile(path.join(attemptDir, "raw.log"), rawLogLines.join("\n") + "\n");
}

test("graph: every node traces to a real raw_events row (provenance invariant)", async () => {
  const runsRoot = await makeTempDir("pros-graph-runs-");
  const dbDir = await makeTempDir("pros-graph-db-");
  try {
    const runId = "runProv";
    const attemptId = "att1";
    const { toolUseLine, toolResultLine } = loadRealClaudeToolCallLines();
    await buildRealisticRun(runsRoot, runId, attemptId, [toolUseLine, toolResultLine]);

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const graph = buildSessionGraph(db, runId);
      assert.ok(graph.nodes.length > 0, "expected at least one node");

      const stmt = db.prepare("SELECT run_id, attempt_id, seq FROM raw_events WHERE id = ?");
      for (const node of graph.nodes) {
        const row = stmt.get(node.rawEventId) as { run_id: string; attempt_id: string; seq: number } | undefined;
        assert.ok(row, `node ${node.id} (kind ${node.kind}) must reference a real raw_events row via rawEventId`);
        assert.equal(row!.run_id, node.runId);
        assert.equal(row!.attempt_id, node.attemptId);
        assert.equal(row!.seq, node.seq);
      }

      // Sanity: the real Bash tool_use produced a tool_call node, and the
      // real tool_result produced a tool_result node linked to it.
      const toolCall = graph.nodes.find((n) => n.kind === "tool_call" && n.label.startsWith("Bash:"));
      assert.ok(toolCall, "expected a Bash tool_call node from the real fixture line");
      const toolResult = graph.nodes.find((n) => n.kind === "tool_result");
      assert.ok(toolResult, "expected a tool_result node from the real fixture line");
      const resultEdge = graph.edges.find((e) => e.kind === "tool_result_of" && e.to === toolResult!.id);
      assert.ok(resultEdge, "expected a tool_result_of edge linking the tool_result back to its tool_call");
      assert.equal(resultEdge!.from, toolCall!.id);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("graph: malformed and unknown-type raw_events surface as kind:'unknown' nodes, never dropped", async () => {
  const runsRoot = await makeTempDir("pros-graph-runs-");
  const dbDir = await makeTempDir("pros-graph-db-");
  try {
    const runId = "runUnknown";
    const attemptId = "att1";
    const malformedLine = "this is not json at all {";
    const unknownTypeLine = JSON.stringify({ type: "some_future_event_type", foo: "bar" });
    await buildRealisticRun(runsRoot, runId, attemptId, [malformedLine, unknownTypeLine]);

    const dbPath = path.join(dbDir, "index.sqlite");
    const report = await rebuildIndex(dbPath, runsRoot);
    assert.equal(report.rawEventsInserted, 2);

    const db = new Database(dbPath);
    try {
      const graph = buildSessionGraph(db, runId);
      assert.equal(graph.nodes.length, 2, "both the malformed and unknown-type lines must each produce exactly one node, not be dropped");
      for (const node of graph.nodes) {
        assert.equal(node.kind, "unknown");
        assert.equal(typeof node.rawEventId, "number");
        assert.ok(node.rawEventId > 0);
      }
      // Confirm the underlying raw_events rows really do have the parse
      // statuses we expect -- proves this test exercises the real thing.
      const rows = db.prepare("SELECT parse_status FROM raw_events WHERE run_id = ? ORDER BY seq").all(runId) as { parse_status: string }[];
      assert.deepEqual(rows.map((r) => r.parse_status), ["malformed", "unknown_type"]);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("graph: zero LLM/subprocess involvement -- no spawnClaude/spawnCodex import in src, and runs fast over a large synthetic table", async () => {
  // Approach chosen (documented per the brief's "pick whichever is more
  // convincing and cheap to write, and document your choice"): a static
  // grep over this package's own src/ for any import of the
  // process-spawning adapter exports or child_process spawning APIs, PLUS a
  // runtime behavior assertion (fast completion over a large synthetic
  // raw_events table, no ANTHROPIC_*/OPENAI_*-shaped env var reads
  // required). Monkeypatching node:child_process was judged more fragile
  // and less legible than this combination, since buildSessionGraph's own
  // module graph is small and fully under our control.
  const srcDir = path.join(__dirname, "../src");
  const bannedPatterns = [/spawnClaude/, /spawnCodex/, /from ["']node:child_process["']/, /require\(["']child_process["']\)/];
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts")) continue;
    const contents = await readFile(path.join(srcDir, file), "utf8");
    for (const pattern of bannedPatterns) {
      assert.equal(pattern.test(contents), false, `${file} must not reference ${pattern} -- @pros/graph must never spawn a CLI subprocess`);
    }
  }

  const runsRoot = await makeTempDir("pros-graph-runs-");
  const dbDir = await makeTempDir("pros-graph-db-");
  try {
    const runId = "runBig";
    const attemptId = "att1";
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }] },
        }),
      );
    }
    await buildRealisticRun(runsRoot, runId, attemptId, lines);

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const start = Date.now();
      const graph = buildSessionGraph(db, runId);
      const elapsedMs = Date.now() - start;
      assert.equal(graph.nodes.length, 500);
      assert.ok(elapsedMs < 200, `buildSessionGraph over 500 rows took ${elapsedMs}ms, expected < 200ms for a pure in-process parse (no subprocess/model latency)`);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("graph: summary fields (toolCounts, subagentsSpawned, skillsInvoked, filesWritten, bashVerbs) are correct", async () => {
  const runsRoot = await makeTempDir("pros-graph-runs-");
  const dbDir = await makeTempDir("pros-graph-db-");
  try {
    const runId = "runSummary";
    const attemptId = "att1";
    // Synthetic but shape-realistic claude assistant events, one tool_use
    // each, covering Bash (x3, two distinct verbs), Read, Write, Task,
    // and Skill.
    const events = [
      { name: "Bash", input: { command: "pwd" } },
      { name: "Bash", input: { command: "ls -la" } },
      { name: "Bash", input: { command: "pwd -P" } }, // same verb "pwd" as the first
      { name: "Read", input: { file_path: "/repo/a.ts" } },
      { name: "Write", input: { file_path: "/repo/b.ts" } },
      { name: "Edit", input: { file_path: "/repo/c.ts" } },
      { name: "Task", input: { subagent_type: "finder", description: "find stuff" } },
      { name: "Skill", input: { skill: "code-review" } },
    ];
    const lines = events.map((e, i) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `tool${i}`, name: e.name, input: e.input }] },
      }),
    );
    await buildRealisticRun(runsRoot, runId, attemptId, lines);

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const graph = buildSessionGraph(db, runId);
      assert.deepEqual(graph.summary.toolCounts, { Bash: 3, Read: 1, Write: 1, Edit: 1, Task: 1, Skill: 1 });
      assert.equal(graph.summary.subagentsSpawned, 1);
      assert.deepEqual(graph.summary.skillsInvoked, ["code-review"]);
      assert.deepEqual(new Set(graph.summary.filesWritten), new Set(["/repo/b.ts", "/repo/c.ts"]));
      assert.deepEqual(new Set(graph.summary.bashVerbs), new Set(["pwd", "ls"]));

      const taskNode = graph.nodes.find((n) => n.kind === "subagent");
      assert.ok(taskNode);
      assert.equal(taskNode!.label, "Task: finder");

      const skillNode = graph.nodes.find((n) => n.kind === "skill");
      assert.ok(skillNode);
      assert.equal(skillNode!.label, "Skill: code-review");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("graph: buildSessionGraph is deterministic across repeated calls against the same db", async () => {
  const runsRoot = await makeTempDir("pros-graph-runs-");
  const dbDir = await makeTempDir("pros-graph-db-");
  try {
    const runId = "runDet";
    const attemptId = "att1";
    const { toolUseLine, toolResultLine } = loadRealClaudeToolCallLines();
    const malformedLine = "not json {";
    const unknownTypeLine = JSON.stringify({ type: "unheard_of", x: 1 });
    await buildRealisticRun(runsRoot, runId, attemptId, [toolUseLine, toolResultLine, malformedLine, unknownTypeLine]);

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const graph1: SessionGraph = buildSessionGraph(db, runId);
      const graph2: SessionGraph = buildSessionGraph(db, runId);
      assert.deepEqual(graph2, graph1, "buildSessionGraph must be pure/deterministic over the same db + runId");
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});
