import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConcurrencyLease } from "@pros/lease";
import { runTriggerCycle } from "../src/runner.js";
import type { Signal, TriggerSource } from "../src/types.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    sourceId: "test-source",
    externalId: "ext-1",
    kind: "issue",
    title: "a signal",
    body: "body text",
    raisedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FixedSource implements TriggerSource {
  readonly id: string;
  constructor(
    id: string,
    private readonly signals: Signal[] | (() => Signal[] | Promise<Signal[]>),
  ) {
    this.id = id;
  }
  async fetchSignals(): Promise<Signal[]> {
    return typeof this.signals === "function" ? await this.signals() : this.signals;
  }
}

class ThrowingSource implements TriggerSource {
  readonly id = "broken-source";
  async fetchSignals(): Promise<Signal[]> {
    throw new Error("malformed fixture, boom");
  }
}

async function makeDirs() {
  const dedupDir = await mkdtemp(path.join(tmpdir(), "pros-triggers-dedup-"));
  const leaseDir = await mkdtemp(path.join(tmpdir(), "pros-triggers-lease-"));
  return { dedupDir, leaseDir };
}

test("dedup: same signal seen twice across two cycles -> exactly one admitted run, second call reports duplicate", async () => {
  const { dedupDir, leaseDir } = await makeDirs();
  try {
    const signal = makeSignal({ externalId: "dup-1" });
    const admitted: string[] = [];
    const onNewSignal = async (_s: Signal, ctx: { runId: string }) => {
      admitted.push(ctx.runId);
    };

    const source = new FixedSource("s1", [signal]);

    const cycle1 = await runTriggerCycle({ sources: [source], dedupDir, leaseDir, maxConcurrent: 5, onNewSignal });
    const cycle2 = await runTriggerCycle({ sources: [source], dedupDir, leaseDir, maxConcurrent: 5, onNewSignal });

    assert.equal(cycle1.admittedRunIds.length, 1);
    assert.equal(cycle2.admittedRunIds.length, 0);
    assert.equal(cycle2.duplicatesSuppressed, 1);
    assert.equal(admitted.length, 1, "onNewSignal called exactly once across both cycles");
    assert.equal(cycle1.admittedRunIds[0], cycle1.admittedRunIds[0]); // sanity
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("lease unavailable: new signal is deferred, not consumed; a later cycle with headroom admits it", async () => {
  const { dedupDir, leaseDir } = await makeDirs();
  try {
    const maxConcurrent = 1;
    // Occupy the sole slot with an unrelated run.
    const occupying = await ConcurrencyLease.acquire({ leaseDir, maxConcurrent, runId: "occupying-run" });

    const signal = makeSignal({ externalId: "deferred-1" });
    const admitted: string[] = [];
    const onNewSignal = async (_s: Signal, ctx: { runId: string }) => {
      admitted.push(ctx.runId);
    };
    const source = new FixedSource("s1", [signal]);

    const cycle1 = await runTriggerCycle({ sources: [source], dedupDir, leaseDir, maxConcurrent, onNewSignal });
    assert.equal(cycle1.admittedRunIds.length, 0);
    assert.equal(cycle1.skippedDeferred.length, 1);
    assert.equal(admitted.length, 0);

    // Free the slot, retry -- should now be admitted since it was never claimed.
    await occupying.release();
    const cycle2 = await runTriggerCycle({ sources: [source], dedupDir, leaseDir, maxConcurrent, onNewSignal });
    assert.equal(cycle2.admittedRunIds.length, 1);
    assert.equal(admitted.length, 1);
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("graceful degradation: one source throws, others' signals still admitted, failure recorded", async () => {
  const { dedupDir, leaseDir } = await makeDirs();
  try {
    const healthySignal1 = makeSignal({ sourceId: "healthy-a", externalId: "h1" });
    const healthySignal2 = makeSignal({ sourceId: "healthy-b", externalId: "h2" });
    const admitted: string[] = [];
    const onNewSignal = async (_s: Signal, ctx: { runId: string }) => {
      admitted.push(ctx.runId);
    };

    const sources: TriggerSource[] = [
      new FixedSource("healthy-a", [healthySignal1]),
      new ThrowingSource(),
      new FixedSource("healthy-b", [healthySignal2]),
    ];

    const result = await runTriggerCycle({ sources, dedupDir, leaseDir, maxConcurrent: 5, onNewSignal });

    assert.equal(result.admittedRunIds.length, 2);
    assert.equal(result.sourceFailures.length, 1);
    assert.equal(result.sourceFailures[0].sourceId, "broken-source");
    assert.match(result.sourceFailures[0].error, /malformed fixture/);
    assert.equal(admitted.length, 2);
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("one bad signal's onNewSignal failure doesn't lose other signals from the same source", async () => {
  const { dedupDir, leaseDir } = await makeDirs();
  try {
    const badSignal = makeSignal({ externalId: "bad-1" });
    const goodSignal = makeSignal({ externalId: "good-1" });
    const source = new FixedSource("s1", [badSignal, goodSignal]);

    const onNewSignal = async (s: Signal) => {
      if (s.externalId === "bad-1") throw new Error("admission blew up");
    };

    const result = await runTriggerCycle({ sources: [source], dedupDir, leaseDir, maxConcurrent: 5, onNewSignal });
    assert.equal(result.admittedRunIds.length, 1);
    assert.equal(result.admissionFailures.length, 1);
    assert.equal(result.admissionFailures[0].externalId, "bad-1");
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});
