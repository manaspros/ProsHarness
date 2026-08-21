import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Journal } from "@pros/barrier";
import { GET } from "../app/api/runs/[runId]/graph/stream/route.js";

/**
 * B9 piece 4 regression coverage for the SSE route's stated edge cases:
 * a run with no journal at all closes itself immediately (nothing to
 * stream, nothing running to wait on); a run with a live, never-ended
 * attempt stays open and keeps emitting; and reading a chunk then
 * cancelling the stream's reader must resolve cleanly (no leaked timer).
 *
 * These drive the real GET handler and a real (temp-dir) run directory --
 * no fake HTTP server needed, since a Next.js route handler is just an
 * async function returning a Response.
 */

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function readSseEvents(response: Response, maxEvents: number, timeoutMs = 6000): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < maxEvents && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        events.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

test("graph stream route: a run with no journal at all sends 'done' and closes on its own", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-dashboard-stream-empty-"));
  const dbPath = path.join(runsRoot, "index.sqlite");
  try {
    await withEnv({ PROS_RUNS_DIR: runsRoot, PROS_INDEX_DB: dbPath }, async () => {
      const response = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ runId: "run-does-not-exist" }) });
      assert.equal(response.headers.get("Content-Type"), "text/event-stream");
      const events = await readSseEvents(response, 2);
      assert.ok(events.some((e) => e.startsWith("event: done")), `expected a "done" event, got: ${JSON.stringify(events)}`);
    });
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("graph stream route: a run with a live (never-ended) attempt emits a graph event and does NOT close", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-dashboard-stream-live-"));
  const dbPath = path.join(runsRoot, "index.sqlite");
  const runId = "run-live-1";
  const runDir = path.join(runsRoot, runId);
  try {
    const journal = await Journal.open(runDir);
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "attempt_started",
      attemptId: `${runId}-implement`,
      cwd: runDir,
      launchConfigHash: "h",
      unitName: "u",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    await withEnv({ PROS_RUNS_DIR: runsRoot, PROS_INDEX_DB: dbPath }, async () => {
      const response = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ runId }) });
      const events = await readSseEvents(response, 1, 4000);
      assert.ok(events.some((e) => e.startsWith("event: graph")), `expected a "graph" event, got: ${JSON.stringify(events)}`);
      assert.ok(!events.some((e) => e.startsWith("event: done")), "a run with a live attempt must not close the stream");
    });
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("graph stream route: cancelling the reader (client disconnect) resolves cleanly without hanging", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-dashboard-stream-cancel-"));
  const dbPath = path.join(runsRoot, "index.sqlite");
  const runId = "run-cancel-1";
  const runDir = path.join(runsRoot, runId);
  try {
    const journal = await Journal.open(runDir);
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "attempt_started",
      attemptId: `${runId}-implement`,
      cwd: runDir,
      launchConfigHash: "h",
      unitName: "u",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    await withEnv({ PROS_RUNS_DIR: runsRoot, PROS_INDEX_DB: dbPath }, async () => {
      const response = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ runId }) });
      const reader = response.body!.getReader();
      await reader.read(); // read the first ("graph") chunk
      await assert.doesNotReject(() => reader.cancel());
    });
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
