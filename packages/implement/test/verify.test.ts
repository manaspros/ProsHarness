import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Journal, StaleFenceError } from "@pros/barrier";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { runVerification } from "../src/verify.js";

async function makeRunDir(): Promise<{ runsRoot: string; runDir: string }> {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-verify-test-"));
  const runDir = path.join(runsRoot, "run-1");
  await mkdir(runDir, { recursive: true });
  return { runsRoot, runDir };
}

class FixedSession {
  readonly provider = "claude" as const;
  calls = 0;
  constructor(
    private readonly text: string,
    private readonly usage = { inputTokens: 10, outputTokens: 10 },
  ) {}

  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    this.calls++;
    return { text: this.text, usage: this.usage };
  }
}

test("fresh session returning a schema-conforming pass verdict is returned as-is", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const session = new FixedSession(JSON.stringify({ outcome: "pass", summary: "all good", failingChecks: [] }));
    const verdict = await runVerification({
      verifierSession: session,
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
    });
    assert.equal(verdict.outcome, "pass");
    assert.equal(verdict.summary, "all good");
    assert.deepEqual(verdict.failingChecks, []);
    assert.equal(session.calls, 1);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("mismatched expectedFenceEpoch throws StaleFenceError WITHOUT ever calling the model", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    // Bump the run's real fence epoch to 1 via a real journal append.
    const journal = await Journal.open(runDir);
    await journal.append({
      runId: "run-1",
      fenceEpoch: 1,
      kind: "fence_bumped",
      previousEpoch: 0,
      newEpoch: 1,
      reason: "test setup",
    });
    await journal.close();

    const session = new FixedSession(JSON.stringify({ outcome: "pass", summary: "ok", failingChecks: [] }));
    await assert.rejects(
      () =>
        runVerification({
          verifierSession: session,
          worktreePath: runDir,
          runId: "run-1",
          runDir,
          expectedFenceEpoch: 0, // stale: actual current epoch is 1
          attemptId: "run-1-verify",
        }),
      StaleFenceError,
    );
    assert.equal(session.calls, 0, "a stale run must not even spend tokens");
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("malformed/non-schema-conforming model output throws, never defaults to pass", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const session = new FixedSession("this is not JSON at all");
    await assert.rejects(() =>
      runVerification({
        verifierSession: session,
        worktreePath: runDir,
        runId: "run-1",
        runDir,
        expectedFenceEpoch: 0,
        attemptId: "run-1-verify",
      }),
    );

    const missingFieldsSession = new FixedSession(JSON.stringify({ outcome: "pass" }));
    await assert.rejects(() =>
      runVerification({
        verifierSession: missingFieldsSession,
        worktreePath: runDir,
        runId: "run-1",
        runDir,
        expectedFenceEpoch: 0,
        attemptId: "run-1-verify",
      }),
    );
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("fence epoch changing DURING verification still throws StaleFenceError and discards the verdict", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    class BumpingSession {
      readonly provider = "claude" as const;
      async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
        // Simulate an amendment/abort landing mid-verification, via a real
        // journal append -- not a mock of the fence.
        const journal = await Journal.open(runDir);
        await journal.append({
          runId: "run-1",
          fenceEpoch: 1,
          kind: "fence_bumped",
          previousEpoch: 0,
          newEpoch: 1,
          reason: "amendment landed mid-verify",
        });
        await journal.close();
        return {
          text: JSON.stringify({ outcome: "pass", summary: "looked fine", failingChecks: [] }),
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      }
    }

    const session = new BumpingSession();
    await assert.rejects(
      () =>
        runVerification({
          verifierSession: session,
          worktreePath: runDir,
          runId: "run-1",
          runDir,
          expectedFenceEpoch: 0,
          attemptId: "run-1-verify",
        }),
      StaleFenceError,
    );
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});
