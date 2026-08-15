import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDue } from "../src/loop.js";
import { readJobStatus, writeJobStatus, listJobStatuses } from "../src/status-store.js";
import type { JobStatus } from "../src/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pros-schedule-status-"));
}

test("isDue: never-run status is due", () => {
  const status: JobStatus = { name: "x", lastStatus: "never-run" };
  assert.equal(isDue(status, 1000, Date.now()), true);
});

test("isDue: run recently is not due", () => {
  const now = Date.now();
  const status: JobStatus = { name: "x", lastStatus: "ok", lastRunAt: new Date(now - 10).toISOString() };
  assert.equal(isDue(status, 1000, now), false);
});

test("isDue: run long enough ago is due again", () => {
  const now = Date.now();
  const status: JobStatus = { name: "x", lastStatus: "ok", lastRunAt: new Date(now - 5000).toISOString() };
  assert.equal(isDue(status, 1000, now), true);
});

test("isDue: exactly at the boundary is due (>=)", () => {
  const now = Date.now();
  const status: JobStatus = { name: "x", lastStatus: "ok", lastRunAt: new Date(now - 1000).toISOString() };
  assert.equal(isDue(status, 1000, now), true);
});

test("status-store: readJobStatus on missing file -> never-run", async () => {
  const dir = await makeTempDir();
  try {
    const status = await readJobStatus(dir, "nonexistent-job");
    assert.deepEqual(status, { name: "nonexistent-job", lastStatus: "never-run" });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("status-store: round trip write then read", async () => {
  const dir = await makeTempDir();
  try {
    const status: JobStatus = {
      name: "my-job",
      lastStatus: "ok",
      lastRunAt: "2026-08-15T00:00:00.000Z",
      lastSummary: { foo: "bar" },
      lastDurationMs: 42,
      nextDueAt: "2026-08-15T00:05:00.000Z",
    };
    await writeJobStatus(dir, status);
    const read = await readJobStatus(dir, "my-job");
    assert.deepEqual(read, status);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("status-store: readJobStatus on corrupt file -> never-run, no throw", async () => {
  const dir = await makeTempDir();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "corrupt-job.json"), "{ not valid json ][", "utf8");
    const status = await readJobStatus(dir, "corrupt-job");
    assert.deepEqual(status, { name: "corrupt-job", lastStatus: "never-run" });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("status-store: listJobStatuses reads every *.json in statusDir", async () => {
  const dir = await makeTempDir();
  try {
    await writeJobStatus(dir, { name: "job-a", lastStatus: "ok", lastRunAt: "2026-08-15T00:00:00.000Z" });
    await writeJobStatus(dir, { name: "job-b", lastStatus: "error", lastError: "boom" });
    const statuses = await listJobStatuses(dir);
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(statuses.length, 2);
    assert.equal(byName["job-a"]!.lastStatus, "ok");
    assert.equal(byName["job-b"]!.lastStatus, "error");
    assert.equal(byName["job-b"]!.lastError, "boom");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("status-store: listJobStatuses on missing statusDir -> []", async () => {
  const dir = path.join(tmpdir(), "pros-schedule-status-does-not-exist-" + Math.random().toString(36).slice(2));
  const statuses = await listJobStatuses(dir);
  assert.deepEqual(statuses, []);
});
