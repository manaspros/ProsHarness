import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSchedulerLoop } from "../src/loop.js";
import { readJobStatus } from "../src/status-store.js";
import type { ScheduledJob } from "../src/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pros-schedule-loop-"));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("startSchedulerLoop: fires a due job at least once without a manual runJobOnce call, then stop() halts further runs", async () => {
  const dir = await makeTempDir();
  try {
    let runCount = 0;
    const job: ScheduledJob = {
      name: "tiny-job",
      intervalMs: 5,
      run: async () => {
        runCount++;
        return { count: runCount };
      },
    };

    const handle = startSchedulerLoop({ jobs: [job], statusDir: dir, pollIntervalMs: 5 });

    // Give it a handful of poll ticks to fire at least once.
    await wait(80);
    handle.stop();

    const statusAfterStop = await readJobStatus(dir, "tiny-job");
    assert.equal(statusAfterStop.lastStatus, "ok");
    assert.ok(runCount >= 1, "job should have run at least once");

    const runCountAtStop = runCount;
    const lastRunAtStop = statusAfterStop.lastRunAt;

    // Wait a bit longer -- no further runs should happen after stop().
    await wait(60);
    const statusAfterWait = await readJobStatus(dir, "tiny-job");
    assert.equal(runCount, runCountAtStop, "no further runs should occur after stop()");
    assert.equal(statusAfterWait.lastRunAt, lastRunAtStop, "lastRunAt must not change after stop()");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("startSchedulerLoop: onTick observability hook is called with current statuses each poll", async () => {
  const dir = await makeTempDir();
  try {
    const job: ScheduledJob = {
      name: "observed-job",
      intervalMs: 5,
      run: async () => ({ ran: true }),
    };

    let tickCount = 0;
    let sawOkStatus = false;
    const handle = startSchedulerLoop({
      jobs: [job],
      statusDir: dir,
      pollIntervalMs: 5,
      onTick: (statuses) => {
        tickCount++;
        if (statuses.some((s) => s.name === "observed-job" && s.lastStatus === "ok")) {
          sawOkStatus = true;
        }
      },
    });

    await wait(80);
    handle.stop();

    assert.ok(tickCount >= 1, "onTick should have fired at least once");
    assert.ok(sawOkStatus, "onTick should observe the job's ok status after it ran");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
