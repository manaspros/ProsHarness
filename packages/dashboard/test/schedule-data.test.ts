import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { getScheduleStatusDir, listScheduleStatuses } from "../lib/schedule-data.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("getScheduleStatusDir: respects PROS_SCHEDULE_STATUS_DIR when set", () => {
  const saved = process.env.PROS_SCHEDULE_STATUS_DIR;
  try {
    process.env.PROS_SCHEDULE_STATUS_DIR = "/tmp/some-custom-schedule-status";
    assert.equal(getScheduleStatusDir(), "/tmp/some-custom-schedule-status");
  } finally {
    if (saved === undefined) delete process.env.PROS_SCHEDULE_STATUS_DIR;
    else process.env.PROS_SCHEDULE_STATUS_DIR = saved;
  }
});

test("getScheduleStatusDir: falls back to <HOME>/.pros/schedule when unset", () => {
  const saved = process.env.PROS_SCHEDULE_STATUS_DIR;
  try {
    delete process.env.PROS_SCHEDULE_STATUS_DIR;
    assert.equal(getScheduleStatusDir(), path.join(homedir(), ".pros", "schedule"));
  } finally {
    if (saved === undefined) delete process.env.PROS_SCHEDULE_STATUS_DIR;
    else process.env.PROS_SCHEDULE_STATUS_DIR = saved;
  }
});

test("listScheduleStatuses: missing statusDir -> []", async () => {
  const dir = path.join(tmpdir(), "pros-dash-schedule-does-not-exist-" + Math.random().toString(36).slice(2));
  assert.deepEqual(listScheduleStatuses(dir), []);
});

test("listScheduleStatuses: valid ok status and error status both parse correctly", async () => {
  const dir = await makeTempDir("pros-dash-schedule-");
  try {
    await writeFile(
      path.join(dir, "trigger-sweep.json"),
      JSON.stringify({
        name: "trigger-sweep",
        lastStatus: "ok",
        lastRunAt: "2026-08-15T00:00:00.000Z",
        nextDueAt: "2026-08-15T00:05:00.000Z",
        lastSummary: { admitted: 2 },
      }),
    );
    await writeFile(
      path.join(dir, "skillrank-weekly.json"),
      JSON.stringify({
        name: "skillrank-weekly",
        lastStatus: "error",
        lastRunAt: "2026-08-14T00:00:00.000Z",
        nextDueAt: "2026-08-21T00:00:00.000Z",
        lastError: "lock file unreadable",
      }),
    );

    const statuses = listScheduleStatuses(dir);
    assert.equal(statuses.length, 2);
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
    assert.equal(byName["trigger-sweep"]!.lastStatus, "ok");
    assert.deepEqual(byName["trigger-sweep"]!.lastSummary, { admitted: 2 });
    assert.equal(byName["skillrank-weekly"]!.lastStatus, "error");
    assert.equal(byName["skillrank-weekly"]!.lastError, "lock file unreadable");
  } finally {
    await cleanup(dir);
  }
});

test("listScheduleStatuses: malformed JSON file is dropped, not fatal", async () => {
  const dir = await makeTempDir("pros-dash-schedule-");
  try {
    await writeFile(path.join(dir, "broken.json"), "{ not valid json ][");
    await writeFile(
      path.join(dir, "good.json"),
      JSON.stringify({ name: "good", lastStatus: "never-run" }),
    );
    const statuses = listScheduleStatuses(dir);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.name, "good");
  } finally {
    await cleanup(dir);
  }
});

test("listScheduleStatuses: wrong-shaped entry (bad lastStatus value) is dropped", async () => {
  const dir = await makeTempDir("pros-dash-schedule-");
  try {
    await writeFile(
      path.join(dir, "weird.json"),
      JSON.stringify({ name: "weird", lastStatus: "totally-not-a-real-status" }),
    );
    const statuses = listScheduleStatuses(dir);
    assert.deepEqual(statuses, []);
  } finally {
    await cleanup(dir);
  }
});

test("listScheduleStatuses: sorted deterministically by name", async () => {
  const dir = await makeTempDir("pros-dash-schedule-");
  try {
    await writeFile(path.join(dir, "zzz.json"), JSON.stringify({ name: "zzz-job", lastStatus: "never-run" }));
    await writeFile(path.join(dir, "aaa.json"), JSON.stringify({ name: "aaa-job", lastStatus: "never-run" }));
    const statuses = listScheduleStatuses(dir);
    assert.deepEqual(
      statuses.map((s) => s.name),
      ["aaa-job", "zzz-job"],
    );
  } finally {
    await cleanup(dir);
  }
});

test("schedule page: never contains any interactive/mutating constructs (static inspection)", async () => {
  const pagePath = path.join(import.meta.dirname, "..", "app", "schedule", "page.tsx");
  const source = await readFile(pagePath, "utf8");

  const forbidden = ['"use client"', "<form", "onClick", "onSubmit", "fetch(", 'method: "POST"'];
  for (const needle of forbidden) {
    assert.ok(!source.includes(needle), `page.tsx must not contain ${JSON.stringify(needle)}`);
  }
});
