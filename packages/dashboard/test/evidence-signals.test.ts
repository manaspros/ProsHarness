import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal } from "@pros/barrier";
import { rebuildIndex } from "@pros/index";
import { getEvidenceSignals, computeConfidence } from "../lib/evidence-signals.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Appends a validation_command_run journal entry with the given role/exit code. */
async function appendCheck(
  journal: Journal,
  runId: string,
  role: "gate" | "reproduce_before" | "reproduce_after",
  exitCode: number,
): Promise<void> {
  await journal.append({
    runId,
    fenceEpoch: 0,
    kind: "validation_command_run",
    attemptId: "att1",
    command: "pnpm test",
    role,
    exitCode,
    timedOut: false,
    durationMs: 100,
    outputTail: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function withIndex(
  build: (journal: Journal, runId: string) => Promise<void>,
  assertOn: (db: Database.Database, runId: string) => void,
): Promise<void> {
  const runsRoot = await makeTempDir("pros-dash-signals-runs-");
  const dbDir = await makeTempDir("pros-dash-signals-db-");
  try {
    const runId = "run1";
    const runDir = path.join(runsRoot, runId);
    const j = await Journal.open(runDir);
    await build(j, runId);
    await j.close();

    const dbPath = path.join(dbDir, "index.sqlite");
    await rebuildIndex(dbPath, runsRoot);

    const db = new Database(dbPath, { readonly: true });
    try {
      assertOn(db, runId);
    } finally {
      db.close();
    }
  } finally {
    await cleanup(runsRoot);
    await cleanup(dbDir);
  }
}

test("no journal entries at all -- every signal reads not_established, never pass or fail", async () => {
  await withIndex(
    async () => {},
    (db, runId) => {
      const signals = getEvidenceSignals(db, runId);
      assert.equal(signals.reproduced, "not_established");
      assert.equal(signals.fixProven, "not_established");
      assert.equal(signals.gatesGreen, "not_established");
      assert.equal(signals.independentlyReviewed, "not_established");
      assert.equal(computeConfidence(signals), "low");
    },
  );
});

test("a failing reproduce_before command IS the reproduction -- reads pass", async () => {
  await withIndex(
    async (j, runId) => {
      await appendCheck(j, runId, "reproduce_before", 1);
    },
    (db, runId) => {
      assert.equal(getEvidenceSignals(db, runId).reproduced, "pass");
    },
  );
});

test("a reproduce_before command that exits 0 means the bug did NOT reproduce -- reads fail, not not_established", async () => {
  await withIndex(
    async (j, runId) => {
      await appendCheck(j, runId, "reproduce_before", 0);
    },
    (db, runId) => {
      assert.equal(getEvidenceSignals(db, runId).reproduced, "fail");
    },
  );
});

test("hard rule: fixProven cannot be pass without reproduced being pass first, even with a clean reproduce_after", async () => {
  await withIndex(
    async (j, runId) => {
      // reproduce_before never ran at all; only a (vacuous) reproduce_after exists.
      await appendCheck(j, runId, "reproduce_after", 0);
    },
    (db, runId) => {
      const signals = getEvidenceSignals(db, runId);
      assert.equal(signals.reproduced, "not_established");
      assert.equal(signals.fixProven, "not_established");
    },
  );
});

test("full before/after pair: reproduced pass + fixProven pass", async () => {
  await withIndex(
    async (j, runId) => {
      await appendCheck(j, runId, "reproduce_before", 1);
      await appendCheck(j, runId, "reproduce_after", 0);
    },
    (db, runId) => {
      const signals = getEvidenceSignals(db, runId);
      assert.equal(signals.reproduced, "pass");
      assert.equal(signals.fixProven, "pass");
    },
  );
});

test("gatesGreen trusts the recorded verify_verdict outcome, not raw validation_checks rows", async () => {
  await withIndex(
    async (j, runId) => {
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "verify_verdict",
        outcome: "pass",
        summary: "2 command(s) passed",
        failingChecksJson: JSON.stringify([]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    (db, runId) => {
      assert.equal(getEvidenceSignals(db, runId).gatesGreen, "pass");
    },
  );
});

test("codex_advisory_review status 'unavailable' reads not_established, never reviewed-and-clean", async () => {
  await withIndex(
    async (j, runId) => {
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "codex_advisory_review",
        status: "unavailable",
        findingsJson: "[]",
        unavailableReason: "codex CLI not installed",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    (db, runId) => {
      const signals = getEvidenceSignals(db, runId);
      assert.equal(signals.independentlyReviewed, "not_established");
      assert.notEqual(signals.independentlyReviewed, "pass");
    },
  );
});

test("codex_advisory_review status 'reviewed_blocker' reads fail", async () => {
  await withIndex(
    async (j, runId) => {
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "codex_advisory_review",
        status: "reviewed_blocker",
        findingsJson: JSON.stringify([{ severity: "blocker", claim: "x" }]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    (db, runId) => {
      assert.equal(getEvidenceSignals(db, runId).independentlyReviewed, "fail");
    },
  );
});

test("confidence hard cap: without Reproduced, confidence never reaches high even with every other signal green", async () => {
  await withIndex(
    async (j, runId) => {
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "verify_verdict",
        outcome: "pass",
        summary: "all green",
        failingChecksJson: "[]",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "codex_advisory_review",
        status: "reviewed_no_blocker",
        findingsJson: "[]",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      // No reproduce_before/after at all.
    },
    (db, runId) => {
      const signals = getEvidenceSignals(db, runId);
      assert.equal(signals.reproduced, "not_established");
      assert.notEqual(computeConfidence(signals), "high");
      assert.equal(computeConfidence(signals), "medium");
    },
  );
});

test("confidence reaches high only when gatesGreen, reproduced, and independentlyReviewed are all pass", async () => {
  await withIndex(
    async (j, runId) => {
      await appendCheck(j, runId, "reproduce_before", 1);
      await appendCheck(j, runId, "reproduce_after", 0);
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "verify_verdict",
        outcome: "pass",
        summary: "all green",
        failingChecksJson: "[]",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "codex_advisory_review",
        status: "reviewed_no_blocker",
        findingsJson: "[]",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    (db, runId) => {
      assert.equal(computeConfidence(getEvidenceSignals(db, runId)), "high");
    },
  );
});

test("a failing gate caps confidence at low regardless of other signals", async () => {
  await withIndex(
    async (j, runId) => {
      await appendCheck(j, runId, "reproduce_before", 1);
      await appendCheck(j, runId, "reproduce_after", 0);
      await j.append({
        runId,
        fenceEpoch: 0,
        kind: "verify_verdict",
        outcome: "fail",
        summary: "lint failed",
        failingChecksJson: JSON.stringify(["lint"]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    (db, runId) => {
      assert.equal(computeConfidence(getEvidenceSignals(db, runId)), "low");
    },
  );
});
