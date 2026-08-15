import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SignalDedupStore, signalDedupId } from "../src/dedup.js";
import type { Signal } from "../src/types.js";

function makeSignal(externalId: string): Signal {
  return {
    sourceId: "test",
    externalId,
    kind: "issue",
    title: "t",
    body: "b",
    raisedAt: new Date().toISOString(),
  };
}

test("claim() is idempotent: same signal claimed twice yields same runId, second is isNew=false", async () => {
  const dedupDir = await mkdtemp(path.join(tmpdir(), "pros-triggers-dedup-store-"));
  try {
    const signal = makeSignal("x1");
    const first = await SignalDedupStore.claim(dedupDir, signal);
    const second = await SignalDedupStore.claim(dedupDir, signal);
    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(first.runId, second.runId);
    assert.equal(first.runId, signalDedupId(signal));
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
  }
});

test("hasClaimed reflects claim state", async () => {
  const dedupDir = await mkdtemp(path.join(tmpdir(), "pros-triggers-dedup-store2-"));
  try {
    const signal = makeSignal("x2");
    assert.equal(await SignalDedupStore.hasClaimed(dedupDir, signal), false);
    await SignalDedupStore.claim(dedupDir, signal);
    assert.equal(await SignalDedupStore.hasClaimed(dedupDir, signal), true);
  } finally {
    await rm(dedupDir, { recursive: true, force: true });
  }
});

test("different signals produce different dedup ids", () => {
  const a = signalDedupId(makeSignal("a"));
  const b = signalDedupId(makeSignal("b"));
  assert.notEqual(a, b);
});
