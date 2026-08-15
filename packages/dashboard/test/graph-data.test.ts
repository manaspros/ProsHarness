import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal } from "@pros/barrier";
import { rebuildIndex } from "@pros/index";
import { loadSessionGraph, groupNodesByAttempt, hasUnknownNodes, countUnknownNodes } from "../lib/graph-data.js";

/**
 * This does NOT re-prove @pros/graph's own correctness (already fully
 * tested in packages/graph/test/graph.test.ts) -- it only proves the
 * dashboard's own integration wiring works end to end: a real rebuilt
 * index in, a real SessionGraph out, via this package's own loadSessionGraph
 * seam. Kept small and fast per the brief.
 */

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("loadSessionGraph: dashboard wiring returns a graph whose nodes all have a real rawEventId", async () => {
  const runsRoot = await makeTempDir("pros-dash-graph-runs-");
  const dbDir = await makeTempDir("pros-dash-graph-db-");
  try {
    const runId = "run1";
    const attemptId = "att1";

    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await j.append({ runId, fenceEpoch: 0, kind: "attempt_started", attemptId, cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();

    const attemptDir = path.join(runDir, "attempts", attemptId);
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, "provider.txt"), "claude");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] },
      }),
      "not json {",
    ];
    await writeFile(path.join(attemptDir, "raw.log"), lines.join("\n") + "\n");

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath);
    try {
      const graph = loadSessionGraph(db, runId);
      assert.ok(graph.nodes.length >= 2);

      const stmt = db.prepare("SELECT id FROM raw_events WHERE id = ?");
      for (const node of graph.nodes) {
        const row = stmt.get(node.rawEventId);
        assert.ok(row, `node ${node.id} must reference a real raw_events row`);
      }

      assert.equal(hasUnknownNodes(graph), true);
      assert.equal(countUnknownNodes(graph), 1);

      const grouped = groupNodesByAttempt(graph.nodes);
      assert.equal(grouped.length, 1);
      assert.equal(grouped[0]!.attemptId, attemptId);
      assert.equal(grouped[0]!.nodes.length, graph.nodes.length);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
});

test("groupNodesByAttempt: groups preserve first-seen attempt order and within-group order", () => {
  const nodes = [
    { id: "a1", runId: "r", attemptId: "att-2", rawEventId: 1, seq: 0, provider: "claude" as const, kind: "prompt" as const, label: "x" },
    { id: "a2", runId: "r", attemptId: "att-1", rawEventId: 2, seq: 0, provider: "claude" as const, kind: "prompt" as const, label: "y" },
    { id: "a3", runId: "r", attemptId: "att-2", rawEventId: 3, seq: 1, provider: "claude" as const, kind: "prompt" as const, label: "z" },
  ];
  const grouped = groupNodesByAttempt(nodes);
  assert.deepEqual(grouped.map((g) => g.attemptId), ["att-2", "att-1"]);
  assert.deepEqual(grouped[0]!.nodes.map((n) => n.id), ["a1", "a3"]);
  assert.deepEqual(grouped[1]!.nodes.map((n) => n.id), ["a2"]);
});
