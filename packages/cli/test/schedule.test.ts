import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJobStatus } from "@pros/schedule";
import { runScheduleStatusCommand, resolveScheduleDirs } from "../src/schedule.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("resolveScheduleDirs: respects env vars, falls back to <HOME>/.pros/*", () => {
  const dirs = resolveScheduleDirs({ HOME: "/home/tester" } as NodeJS.ProcessEnv);
  assert.equal(dirs.statusDir, path.join("/home/tester", ".pros", "schedule"));
  assert.equal(dirs.runsRoot, path.join("/home/tester", ".pros", "runs"));

  const custom = resolveScheduleDirs({ HOME: "/home/tester", PROS_SCHEDULE_STATUS_DIR: "/custom/status" } as NodeJS.ProcessEnv);
  assert.equal(custom.statusDir, "/custom/status");
});

test("pros schedule status: reads and formats a real status file correctly", async () => {
  const statusDir = await makeTempDir("pros-cli-schedule-status-");
  try {
    await writeJobStatus(statusDir, {
      name: "trigger-sweep",
      lastStatus: "ok",
      lastRunAt: "2026-08-15T00:00:00.000Z",
      nextDueAt: "2026-08-15T00:05:00.000Z",
      lastSummary: { admitted: 2 },
    });
    await writeJobStatus(statusDir, {
      name: "skillrank-weekly",
      lastStatus: "error",
      lastRunAt: "2026-08-14T00:00:00.000Z",
      nextDueAt: "2026-08-21T00:00:00.000Z",
      lastError: "lock file unreadable",
    });

    const env = { HOME: "/root", PROS_SCHEDULE_STATUS_DIR: statusDir } as NodeJS.ProcessEnv;
    const output = await runScheduleStatusCommand([], env);

    assert.match(output, /trigger-sweep:.*status=ok.*lastRunAt=2026-08-15T00:00:00\.000Z.*nextDueAt=2026-08-15T00:05:00\.000Z/);
    assert.match(output, /skillrank-weekly:.*status=error.*error="lock file unreadable"/);
  } finally {
    await rm(statusDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros schedule status: no status files yet -> a clear 'never run' message, no throw", async () => {
  const statusDir = await makeTempDir("pros-cli-schedule-status-empty-");
  try {
    await rm(statusDir, { recursive: true, force: true }); // simulate: directory doesn't even exist yet
    const env = { HOME: "/root", PROS_SCHEDULE_STATUS_DIR: statusDir } as NodeJS.ProcessEnv;
    const output = await runScheduleStatusCommand([], env);
    assert.match(output, /no scheduled jobs have ever run yet/);
  } finally {
    await rm(statusDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
