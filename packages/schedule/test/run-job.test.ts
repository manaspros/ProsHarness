import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJobOnce } from "../src/run-job.js";
import { readJobStatus } from "../src/status-store.js";
import type { ScheduledJob } from "../src/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pros-schedule-run-job-"));
}

test("runJobOnce: success path records lastStatus ok with the real summary", async () => {
  const dir = await makeTempDir();
  try {
    const job: ScheduledJob = {
      name: "healthy-job",
      intervalMs: 1000,
      run: async () => ({ widgets: 3 }),
    };
    const status = await runJobOnce(job, dir);
    assert.equal(status.lastStatus, "ok");
    assert.deepEqual(status.lastSummary, { widgets: 3 });
    assert.ok(status.lastRunAt);
    assert.ok(status.nextDueAt);
    assert.equal(status.lastError, undefined);

    const persisted = await readJobStatus(dir, "healthy-job");
    assert.equal(persisted.lastStatus, "ok");
    assert.deepEqual(persisted.lastSummary, { widgets: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("runJobOnce: failing job records lastStatus error with the real thrown message, does not throw, and nextDueAt still advances", async () => {
  const dir = await makeTempDir();
  try {
    const job: ScheduledJob = {
      name: "broken-job",
      intervalMs: 1000,
      run: async () => {
        throw new Error("very specific failure: widget factory offline");
      },
    };

    let status;
    await assert.doesNotReject(async () => {
      status = await runJobOnce(job, dir);
    });

    assert.equal(status!.lastStatus, "error");
    assert.equal(status!.lastError, "very specific failure: widget factory offline");
    assert.ok(status!.lastRunAt, "lastRunAt must be set even on failure -- the attempt happened");
    assert.ok(status!.nextDueAt, "nextDueAt must still advance so the loop retries rather than spinning");

    const lastRunMs = Date.parse(status!.lastRunAt!);
    const nextDueMs = Date.parse(status!.nextDueAt!);
    assert.ok(nextDueMs - lastRunMs >= 999, "nextDueAt should be ~intervalMs after lastRunAt");

    const persisted = await readJobStatus(dir, "broken-job");
    assert.equal(persisted.lastStatus, "error");
    assert.equal(persisted.lastError, "very specific failure: widget factory offline");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("runJobOnce: two jobs, one always fails and one always succeeds -- neither's status overwrites or blocks the other", async () => {
  const dir = await makeTempDir();
  try {
    const healthyJob: ScheduledJob = {
      name: "healthy-job-2",
      intervalMs: 1000,
      run: async () => ({ ok: true }),
    };
    const brokenJob: ScheduledJob = {
      name: "broken-job-2",
      intervalMs: 1000,
      run: async () => {
        throw new Error("consistently broken");
      },
    };

    for (let i = 0; i < 3; i++) {
      await runJobOnce(healthyJob, dir);
      await runJobOnce(brokenJob, dir);
    }

    const healthyStatus = await readJobStatus(dir, "healthy-job-2");
    const brokenStatus = await readJobStatus(dir, "broken-job-2");

    assert.equal(healthyStatus.lastStatus, "ok");
    assert.deepEqual(healthyStatus.lastSummary, { ok: true });
    assert.equal(brokenStatus.lastStatus, "error");
    assert.equal(brokenStatus.lastError, "consistently broken");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
