import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConcurrencyLease, LeaseUnavailableError, leasePathFor } from "../src/concurrency-lease.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pros-lease-test-"));
}

async function writeAgedLeaseFile(leaseDir: string, runId: string, ageMs: number): Promise<void> {
  const staleTs = new Date(Date.now() - ageMs).toISOString();
  await writeFile(
    leasePathFor(leaseDir, runId),
    JSON.stringify({ runId, acquiredAt: staleTs, heartbeatAt: staleTs, pid: 999999 }, null, 2),
  );
}

test("acquire() succeeds under the limit and fails for a new runId once at the limit", async () => {
  const leaseDir = await makeTempDir();
  try {
    const runA = `run-a-${randomUUID()}`;
    const runB = `run-b-${randomUUID()}`;
    const leaseA = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runA });
    assert.ok(leaseA);

    await assert.rejects(
      ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runB }),
      LeaseUnavailableError,
    );
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("release() frees a slot for a subsequent acquire() with a new runId", async () => {
  const leaseDir = await makeTempDir();
  try {
    const runA = `run-a-${randomUUID()}`;
    const runB = `run-b-${randomUUID()}`;
    const leaseA = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runA });
    await leaseA.release();

    const leaseB = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runB });
    assert.ok(leaseB);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("re-acquiring with the same runId is reentrant/idempotent, even at the concurrency limit", async () => {
  const leaseDir = await makeTempDir();
  try {
    const runA = `run-a-${randomUUID()}`;
    await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runA });

    // At the limit already (1/1) -- re-acquiring the SAME runId must not throw.
    const again = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runA });
    assert.ok(again);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("a stale lease (dead heartbeat) is not counted toward maxConcurrent", async () => {
  const leaseDir = await makeTempDir();
  try {
    const deadRunId = `dead-${randomUUID()}`;
    // Write a lease file directly with an old heartbeat, simulating a crashed run.
    await writeAgedLeaseFile(leaseDir, deadRunId, 120_000);

    const newRunId = `new-${randomUUID()}`;
    const lease = await ConcurrencyLease.acquire({
      leaseDir,
      maxConcurrent: 1,
      runId: newRunId,
      staleAfterMs: 60_000,
    });
    assert.ok(lease);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("listActive() reports stale: true/false correctly without deleting anything", async () => {
  const leaseDir = await makeTempDir();
  try {
    const liveRunId = `live-${randomUUID()}`;
    const staleRunId = `stale-${randomUUID()}`;
    await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 10, runId: liveRunId });
    await writeAgedLeaseFile(leaseDir, staleRunId, 120_000);

    const active = await ConcurrencyLease.listActive(leaseDir, 60_000);
    const byRunId = new Map(active.map((a) => [a.runId, a]));
    assert.equal(byRunId.get(liveRunId)?.stale, false);
    assert.equal(byRunId.get(staleRunId)?.stale, true);

    // Nothing should have been deleted by a pure read.
    const stillThere = await ConcurrencyLease.listActive(leaseDir, 60_000);
    assert.equal(stillThere.length, 2);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("reconcileStale() deletes only stale lease files and returns their runIds", async () => {
  const leaseDir = await makeTempDir();
  try {
    const liveRunId = `live-${randomUUID()}`;
    const staleRunId = `stale-${randomUUID()}`;
    await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 10, runId: liveRunId });
    await writeAgedLeaseFile(leaseDir, staleRunId, 120_000);

    const { freed } = await ConcurrencyLease.reconcileStale(leaseDir, 60_000);
    assert.deepEqual(freed, [staleRunId]);

    const remaining = await ConcurrencyLease.listActive(leaseDir, 60_000);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.runId, liveRunId);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("two concurrent acquire() calls for different runIds at maxConcurrent 1 never both succeed", async () => {
  const leaseDir = await makeTempDir();
  try {
    const runA = `run-a-${randomUUID()}`;
    const runB = `run-b-${randomUUID()}`;

    const results = await Promise.allSettled([
      ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runA }),
      ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId: runB }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one acquire() must succeed");
    assert.equal(rejected.length, 1, "exactly one acquire() must fail");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof LeaseUnavailableError);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("heartbeat() rewrites heartbeatAt without changing acquiredAt", async () => {
  const leaseDir = await makeTempDir();
  try {
    const runId = `run-${randomUUID()}`;
    const lease = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent: 1, runId });
    const before = await ConcurrencyLease.listActive(leaseDir);
    await new Promise((r) => setTimeout(r, 5));
    await lease.heartbeat();
    const after = await ConcurrencyLease.listActive(leaseDir);

    assert.equal(before[0]?.acquiredAt, after[0]?.acquiredAt);
    assert.ok(Date.parse(after[0]!.heartbeatAt) >= Date.parse(before[0]!.heartbeatAt));
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
});
