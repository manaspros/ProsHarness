import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, symlink, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Barrier, StaleAnswerError } from "../src/barrier.js";
import { Fence, StaleFenceError } from "../src/fence.js";
import { Journal } from "../src/journal.js";
import { readManifest } from "../src/manifest.js";
import { reconcileCwd, CwdReconcileError, acquireRecoveryLease, releaseRecoveryLease } from "../src/resume.js";
import {
  FIXTURE_PATH,
  makeTempRepo,
  makeRunDir,
  cleanupDir,
  uniqueUnitSuffix,
  killUnitsMatching,
  waitFor,
  sleep,
} from "./helpers.js";

async function askQuestion(barrier: Barrier, attemptId: string, idempotencyKey = randomUUID()) {
  return barrier.requestCheckpoint({
    attemptId,
    questionId: randomUUID(),
    idempotencyKey,
    prompt: "continue?",
    options: ["yes", "no"],
  });
}

test("barrier: kill-test #1 - a write attempted after checkpoint is requested never lands", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  const unitName = `pros-kt1-${uniqueUnitSuffix()}`;
  const sentinel = path.join(repo, "sentinel.txt");
  try {
    const barrier = await Barrier.open(runDir, "run-kt1");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: {
        provider: "fixture",
        command: "node",
        args: [FIXTURE_PATH],
        cwd: repo,
        env: { FORKING_CHILD_MODE: "sentinel", FORKING_CHILD_SENTINEL: sentinel, FORKING_CHILD_DELAY_MS: "250" },
      },
    });

    // Let the fixture's own guardian spin up, then immediately request a
    // checkpoint -- well before its 250ms sentinel-write delay elapses.
    await sleep(30);
    await barrier.requestCheckpoint({
      attemptId,
      questionId: randomUUID(),
      idempotencyKey: randomUUID(),
      prompt: "continue?",
      options: ["yes", "no"],
    });

    // The fixture's delayed write would have landed by now if containment
    // had not killed it first.
    await sleep(400);
    await assert.rejects(() => stat(sentinel));

    const { entries } = await Journal.read(runDir);
    assert.ok(entries.some((e) => e.kind === "parked"));
    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #9 - checkpoint requested during an unsafe section is deferred, then parks once the section exits", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-kt9");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });

    await barrier.enterUnsafeSection("git-rebase-lock");
    const { checkpointId, deferred } = await askQuestion(barrier, attemptId);
    assert.equal(deferred, true, "a checkpoint requested inside an unsafe section must be deferred, not dropped or immediately actioned");

    let state = barrier.getState();
    assert.equal(state.checkpoints.get(checkpointId)?.phase, "checkpoint_requested");

    // Replaying the incomplete request must report the same incomplete state;
    // it must not claim that this checkpoint is parked before containment has
    // actually finished.
    const retry = await askQuestion(barrier, attemptId, barrier.getState().checkpoints.get(checkpointId)!.idempotencyKey);
    assert.equal(retry.checkpointId, checkpointId);
    assert.equal(retry.deferred, true);
    assert.notEqual(barrier.getState().checkpoints.get(checkpointId)?.phase, "parked");

    await barrier.exitUnsafeSection("git-rebase-lock");
    // Deferred checkpoint should now have proceeded through quiescing -> parked.
    const parked = await waitFor(async () => barrier.getState().checkpoints.get(checkpointId)?.phase === "parked", 5000);
    assert.equal(parked, true, "the deferred checkpoint must complete exactly once the section is safe, never silently lost");

    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #6 - a late operation against a stale fence epoch is rejected", async () => {
  const runDir = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);
    const fence = new Fence(journal, "run-kt6", 0);
    const capturedEpoch = fence.current();
    await fence.bump("amendment");
    await assert.rejects(() => fence.check(capturedEpoch, "verdict.submit"), StaleFenceError);

    const { entries } = await Journal.read(runDir);
    assert.ok(entries.some((e) => e.kind === "rejected_stale"));
    await journal.close();
  } finally {
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #6b - answering an already-answered checkpoint is rejected as stale, not double-applied", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-kt6b");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const { checkpointId } = await askQuestion(barrier, attemptId);
    await waitFor(async () => barrier.getState().checkpoints.get(checkpointId)?.phase === "parked", 5000);

    const questionId = barrier.getState().checkpoints.get(checkpointId)!.questionId;
    const idem = barrier.getState().checkpoints.get(checkpointId)!.idempotencyKey;
    await barrier.recordAnswer(checkpointId, questionId, idem, "yes", "continue_within_approved_plan");
    await barrier.claim(checkpointId);
    // Now the checkpoint has moved to "claimed", not "parked" -- a second
    // answer (e.g. a duplicate human click, or a replayed request) must be
    // rejected rather than silently re-applied.
    await assert.rejects(
      () => barrier.recordAnswer(checkpointId, questionId, idem, "no", "abort"),
      (err: unknown) => err instanceof StaleAnswerError && err.auditKind === "answer_rejected_stale" && err.phase === "claimed",
    );
    const { entries } = await Journal.read(runDir);
    assert.equal(entries.filter((entry) => entry.kind === "answered").length, 1);
    assert.equal(entries.filter((entry) => entry.kind === "answer_rejected_stale").length, 1);
    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: answer validation and journal mutex make concurrent answers first-writer-wins", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const owner = await Barrier.open(runDir, "run-answer-race");
    const { attemptId } = await owner.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const questionId = randomUUID();
    const idempotencyKey = randomUUID();
    const { checkpointId } = await owner.requestCheckpoint({
      attemptId,
      questionId,
      idempotencyKey,
      prompt: "continue?",
      options: ["yes", "no"],
    });

    await assert.rejects(
      () => owner.recordAnswer(checkpointId, "wrong-question", idempotencyKey, "yes", "continue_within_approved_plan"),
      /questionId does not match/,
    );
    await assert.rejects(
      () => owner.recordAnswer(checkpointId, questionId, "wrong-idempotency-key", "yes", "continue_within_approved_plan"),
      /idempotencyKey does not match/,
    );
    await assert.rejects(
      () => owner.recordAnswer(checkpointId, questionId, idempotencyKey, "maybe", "continue_within_approved_plan"),
      /answer must be one of the options/,
    );
    assert.equal(owner.getState().checkpoints.get(checkpointId)?.phase, "parked");

    // Separate Barrier instances give each caller its own in-process queue;
    // only the journal's cross-process mutex can serialize this race.
    const contender = await Barrier.open(runDir, "run-answer-race");
    try {
      const outcomes = await Promise.allSettled([
        owner.recordAnswer(checkpointId, questionId, idempotencyKey, "yes", "continue_within_approved_plan"),
        contender.recordAnswer(checkpointId, questionId, idempotencyKey, "no", "continue_within_approved_plan"),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      assert.ok(rejected && rejected.reason instanceof StaleAnswerError);
      assert.equal((rejected as PromiseRejectedResult).reason.auditKind, "answer_late");
      assert.equal((rejected as PromiseRejectedResult).reason.phase, "answered");
    } finally {
      await contender.close();
    }

    const { entries } = await Journal.read(runDir);
    assert.equal(entries.filter((entry) => entry.kind === "answered").length, 1);
    assert.equal(entries.filter((entry) => entry.kind === "answer_late").length, 1);
    assert.equal(owner.getState().checkpoints.get(checkpointId)?.phase, "answered");
    await owner.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: requestCheckpoint is idempotent -- a replayed ask_human call with the same idempotency key never mints a second question", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-idem");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const idem = randomUUID();
    const first = await askQuestion(barrier, attemptId, idem);
    // Simulate the tool call being replayed after a crash, before the daemon
    // had durably recorded that it already turned into a checkpoint.
    const second = await barrier.requestCheckpoint({
      attemptId,
      questionId: randomUUID(), // even with a different questionId
      idempotencyKey: idem,
      prompt: "continue?",
      options: ["yes", "no"],
    });
    assert.equal(second.checkpointId, first.checkpointId);
    assert.equal(barrier.getState().checkpoints.size, 1);
    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: concurrent Gate 2 parks with one idempotency key create one checkpoint", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  let first: Barrier | undefined;
  let second: Barrier | undefined;
  try {
    first = await Barrier.open(runDir, "run-gate2-race");
    second = await Barrier.open(runDir, "run-gate2-race");

    const idempotencyKey = randomUUID();
    const results = await Promise.all([
      first.parkForGate2({
        cwd: repo,
        prompt: "review the draft PR",
        options: ["reviewed"],
        questionId: randomUUID(),
        idempotencyKey,
        prRef: { url: "https://github.com/example/repo/pull/7", number: 7, headSha: "abc123" },
      }),
      second.parkForGate2({
        cwd: repo,
        prompt: "review the draft PR",
        options: ["reviewed"],
        questionId: randomUUID(),
        idempotencyKey,
        prRef: { url: "https://github.com/example/repo/pull/7", number: 7, headSha: "abc123" },
      }),
    ]);

    assert.equal(results[0]!.checkpointId, results[1]!.checkpointId);
    const { entries } = await Journal.read(runDir);
    assert.equal(entries.filter((entry) => entry.kind === "checkpoint_requested" && entry.idempotencyKey === idempotencyKey).length, 1);
    assert.equal(entries.filter((entry) => entry.kind === "quiescing").length, 1);
    assert.equal(entries.filter((entry) => entry.kind === "parked").length, 1);
    assert.equal(first.getState().checkpoints.size, 1);
    assert.equal(first.getState().checkpoints.get(results[0]!.checkpointId)?.phase, "parked");
  } finally {
    await second?.close();
    await first?.close();
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #5 - a second resume of the same checkpoint is refused, never forked", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-kt5");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const { checkpointId } = await askQuestion(barrier, attemptId);
    await waitFor(async () => barrier.getState().checkpoints.get(checkpointId)?.phase === "parked", 5000);
    const cp = barrier.getState().checkpoints.get(checkpointId)!;
    await barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, "yes", "continue_within_approved_plan");
    await barrier.claim(checkpointId);

    const first = await barrier.resume(checkpointId);
    assert.ok(first.attemptId);

    // A crash "after spawning resume but before its attempt record is
    // durable" is modeled here as: something tries to resume again. It must
    // be refused outright rather than launching a second competing attempt,
    // because the checkpoint's phase has already moved past "claimed".
    await assert.rejects(() => barrier.resume(checkpointId));

    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #8 - resume detects a recorded cwd that moved, was deleted, or was symlink-swapped", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-kt8");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const { checkpointId } = await askQuestion(barrier, attemptId);
    await waitFor(async () => barrier.getState().checkpoints.get(checkpointId)?.phase === "parked", 5000);

    const manifest = await readManifest(runDir);
    assert.ok(manifest);

    // Case 1: unchanged -- reconciliation must succeed.
    await reconcileCwd(manifest!);

    // Case 2: directory deleted.
    const movedAway = `${repo}-moved-away`;
    await rename(repo, movedAway);
    await assert.rejects(() => reconcileCwd(manifest!), (err: unknown) => err instanceof CwdReconcileError && err.reason === "missing");

    // Case 3: replaced by a symlink to a different real directory.
    const decoyRepo = await makeTempRepo();
    await symlink(decoyRepo, repo);
    await assert.rejects(
      () => reconcileCwd(manifest!),
      (err: unknown) => err instanceof CwdReconcileError && err.reason === "identity_mismatch",
    );

    await (await import("node:fs/promises")).unlink(repo);
    await rename(movedAway, repo);
    await reconcileCwd(manifest!); // restored -- reconciliation succeeds again

    await cleanupDir(decoyRepo);
    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo).catch(() => undefined);
    await cleanupDir(`${repo}-moved-away`).catch(() => undefined);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #10 - a journal write failure fails closed: no answer accepted, no resume permitted", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const barrier = await Barrier.open(runDir, "run-kt10");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const { checkpointId } = await askQuestion(barrier, attemptId);
    await waitFor(async () => barrier.getState().checkpoints.get(checkpointId)?.phase === "parked", 5000);

    // Simulate disk-full / IO error on the next journal write. A real
    // ENOSPC/EIO surfaces identically to Journal.append's caller -- this
    // makes the fault deterministic without needing to actually exhaust a
    // disk in a test run.
    barrier.simulateJournalIOFailureOnce();
    const cp = barrier.getState().checkpoints.get(checkpointId)!;
    await assert.rejects(() =>
      barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, "yes", "continue_within_approved_plan"),
    );
    // State must not have advanced past "parked" -- the failed append must
    // not be treated as if it succeeded.
    assert.equal(barrier.getState().checkpoints.get(checkpointId)?.phase, "parked");

    // Recovery: the fault was one-shot, so the same answer now succeeds --
    // fail-closed does not mean permanently wedged once the underlying IO
    // problem clears.
    await barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, "yes", "continue_within_approved_plan");
    assert.equal(barrier.getState().checkpoints.get(checkpointId)?.phase, "answered");

    await barrier.close();
  } finally {
    await killUnitsMatching("pros-");
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("barrier: kill-test #11 - two concurrent recovery attempts race for the lease; exactly one wins", async () => {
  const runDir = await makeRunDir();
  try {
    const results = await Promise.all([
      acquireRecoveryLease(runDir, "worker-a"),
      acquireRecoveryLease(runDir, "worker-b"),
    ]);
    const winners = results.filter(Boolean).length;
    assert.equal(winners, 1, "exactly one recovery worker may hold the lease, no matter how the race lands");
    const winnerId = results[0] ? "worker-a" : "worker-b";

    // Releasing with the WRONG holder id must be a no-op: the real owner's lease stays held.
    await releaseRecoveryLease(runDir, "worker-not-the-owner");
    const stolen = await acquireRecoveryLease(runDir, "worker-c");
    assert.equal(stolen, false, "releasing with a non-owning holder id must not free the lease for someone else");

    // The real owner releasing it does free it up for the next recovery attempt.
    await releaseRecoveryLease(runDir, winnerId);
    const afterRelease = await acquireRecoveryLease(runDir, "worker-d");
    assert.equal(afterRelease, true, "the actual owner releasing the lease must free it");
  } finally {
    await cleanupDir(runDir);
  }
});
