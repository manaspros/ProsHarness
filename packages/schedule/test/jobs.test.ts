import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Signal, TriggerSource } from "@pros/triggers";
import { makeTriggerSweepJob, makeSkillrankWeeklyJob } from "../src/jobs.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

class EmptySource implements TriggerSource {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async fetchSignals(): Promise<Signal[]> {
    return [];
  }
}

class FailingSource implements TriggerSource {
  readonly id = "flaky";
  async fetchSignals(): Promise<Signal[]> {
    throw new Error("flaky source is down");
  }
}

test("makeTriggerSweepJob: wiring + summary shape, sources returning [] -> nothing admitted", async () => {
  const dedupDir = await makeTempDir("pros-schedule-jobs-dedup-");
  const leaseDir = await makeTempDir("pros-schedule-jobs-lease-");
  const worktreesRoot = await makeTempDir("pros-schedule-jobs-wt-");
  const runsRoot = await makeTempDir("pros-schedule-jobs-runs-");
  const repoRoot = await makeTempDir("pros-schedule-jobs-repo-");
  try {
    const job = makeTriggerSweepJob({
      sources: [new EmptySource("linear"), new EmptySource("slack")],
      dedupDir,
      leaseDir,
      maxConcurrent: 2,
      repoRoot,
      worktreesRoot,
      runsRoot,
      maxTokensPerRun: 100_000,
    });

    assert.equal(job.name, "trigger-sweep");
    assert.equal(job.intervalMs, 5 * 60 * 1000);

    const summary = await job.run();
    assert.deepEqual(summary, {
      admitted: 0,
      deferred: 0,
      duplicates: 0,
      sourceFailures: 0,
      sourceFailureIds: [],
      admissionFailures: 0,
    });
  } finally {
    await rm(dedupDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("makeTriggerSweepJob: honors a custom intervalMs override", async () => {
  const dedupDir = await makeTempDir("pros-schedule-jobs-dedup-");
  const leaseDir = await makeTempDir("pros-schedule-jobs-lease-");
  try {
    const job = makeTriggerSweepJob({
      sources: [],
      dedupDir,
      leaseDir,
      maxConcurrent: 1,
      repoRoot: "/tmp/does-not-matter",
      worktreesRoot: "/tmp/does-not-matter",
      runsRoot: "/tmp/does-not-matter",
      maxTokensPerRun: 1000,
      intervalMs: 12345,
    });
    assert.equal(job.intervalMs, 12345);
  } finally {
    await rm(dedupDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("makeTriggerSweepJob: a source that errors is reported in sourceFailures, without throwing", async () => {
  const dedupDir = await makeTempDir("pros-schedule-jobs-dedup-");
  const leaseDir = await makeTempDir("pros-schedule-jobs-lease-");
  const worktreesRoot = await makeTempDir("pros-schedule-jobs-wt-");
  const runsRoot = await makeTempDir("pros-schedule-jobs-runs-");
  const repoRoot = await makeTempDir("pros-schedule-jobs-repo-");
  try {
    const job = makeTriggerSweepJob({
      sources: [new FailingSource(), new EmptySource("sweep")],
      dedupDir,
      leaseDir,
      maxConcurrent: 2,
      repoRoot,
      worktreesRoot,
      runsRoot,
      maxTokensPerRun: 100_000,
    });

    const summary = await job.run();
    assert.equal(summary.sourceFailures, 1);
    assert.deepEqual(summary.sourceFailureIds, ["flaky"]);
    assert.equal(summary.admitted, 0);
  } finally {
    await rm(dedupDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(leaseDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("makeSkillrankWeeklyJob: wiring + summary shape, writes output file, no proposals/installs on empty inputs", async () => {
  const outDir = await makeTempDir("pros-schedule-skillrank-out-");
  const minerOutDir = await makeTempDir("pros-schedule-skillrank-miner-");
  const lockDir = await makeTempDir("pros-schedule-skillrank-lock-");
  const lockFilePath = path.join(lockDir, "skill-registry-lock.json");
  try {
    await writeFile(lockFilePath, JSON.stringify({ installed: [] }), "utf8");

    const job = makeSkillrankWeeklyJob({ lockFilePath, minerOutDir, outDir });
    assert.equal(job.name, "skillrank-weekly");
    assert.equal(job.intervalMs, 7 * 24 * 60 * 60 * 1000);

    const summary = await job.run();
    assert.equal(typeof summary.proposalCount, "number");
    assert.equal(typeof summary.installedCount, "number");

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(path.join(outDir, "skill-proposals.json"), "utf8");
    const parsed = JSON.parse(written);
    assert.ok(Array.isArray(parsed.proposals));
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(minerOutDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("makeSkillrankWeeklyJob: honors a custom intervalMs override", async () => {
  const outDir = await makeTempDir("pros-schedule-skillrank-out-");
  const minerOutDir = await makeTempDir("pros-schedule-skillrank-miner-");
  const lockDir = await makeTempDir("pros-schedule-skillrank-lock-");
  const lockFilePath = path.join(lockDir, "skill-registry-lock.json");
  try {
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockFilePath, JSON.stringify({ installed: [] }), "utf8");
    const job = makeSkillrankWeeklyJob({ lockFilePath, minerOutDir, outDir, intervalMs: 999 });
    assert.equal(job.intervalMs, 999);
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(minerOutDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
