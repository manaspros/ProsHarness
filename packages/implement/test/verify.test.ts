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

/** A verifier session that throws instead of returning -- used to prove the harness-derived verdict does not depend on the model call succeeding at all. */
class ThrowingSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    throw new Error("simulated model outage");
  }
}

test("all validation commands exiting 0 derives a pass verdict, with the harness-recorded checks attached", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const session = new FixedSession(JSON.stringify({ summary: "looks good" }));
    const verdict = await runVerification({
      verifierSession: session,
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: [{ command: "exit 0", label: "check-a" }, { command: "true", label: "check-b" }],
    });
    assert.equal(verdict.outcome, "pass");
    assert.equal(verdict.summary, "looks good");
    assert.deepEqual(verdict.failingChecks, []);
    assert.equal(verdict.checks.length, 2);
    assert.ok(verdict.checks.every((c) => c.exitCode === 0));
    assert.equal(verdict.noValidationCommandsConfigured, false);
    assert.equal(session.calls, 1);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

// --- The exit criteria's central regression test -------------------------
//
// "A verdict cannot be pass when any recorded check has a nonzero exit
// code" -- and specifically: NOT by convention. This asserts it holds even
// when the model actively LIES and reports outcome:"pass" in its own text --
// proving the model's self-report has no path to `outcome` at all anymore.

test("nonzero exit code boundary: a failing command forces outcome=fail even when the model's own text claims pass", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    // A hostile/confused model insisting everything passed -- must be fully ignored for `outcome`.
    const lyingSession = new FixedSession(JSON.stringify({ summary: "all good", outcome: "pass" }));
    const verdict = await runVerification({
      verifierSession: lyingSession,
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: [{ command: "exit 0", label: "typecheck" }, { command: "exit 1", label: "test" }],
    });
    assert.equal(verdict.outcome, "fail", "one nonzero-exit check must force outcome=fail regardless of the model's claim");
    assert.equal(verdict.checks.length, 2);
    assert.equal(verdict.checks[1]!.exitCode, 1);
    assert.ok(verdict.failingChecks.some((f) => f.includes("test") && f.includes("exit 1")));
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("a model call that throws entirely still produces a derived verdict -- the model is advisory, not load-bearing", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const verdict = await runVerification({
      verifierSession: new ThrowingSession(),
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: [{ command: "exit 1", label: "test" }],
    });
    assert.equal(verdict.outcome, "fail");
    assert.match(verdict.summary, /failed/);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("empty validationCommands is an explicit, visible vacuous pass -- never indistinguishable from N commands passing", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const session = new FixedSession(JSON.stringify({ summary: "n/a" }));
    const verdict = await runVerification({
      verifierSession: session,
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: [],
    });
    assert.equal(verdict.outcome, "pass");
    assert.equal(verdict.noValidationCommandsConfigured, true);
    assert.deepEqual(verdict.checks, []);
    assert.match(verdict.summary, /no validation commands configured/);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("a hanging validation command is recorded as a timed-out, nonzero-exit failure -- never silence", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
    const session = new FixedSession(JSON.stringify({ summary: "n/a" }));
    const verdict = await runVerification({
      verifierSession: session,
      worktreePath: runDir,
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: [{ command: "sleep 999", label: "hangs" }],
      validationTimeoutMs: 200,
    });
    assert.equal(verdict.outcome, "fail");
    assert.equal(verdict.checks.length, 1);
    assert.equal(verdict.checks[0]!.timedOut, true);
    assert.notEqual(verdict.checks[0]!.exitCode, 0);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("mismatched expectedFenceEpoch throws StaleFenceError WITHOUT ever running validation commands or calling the model", async () => {
  const { runsRoot, runDir } = await makeRunDir();
  try {
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

    const session = new FixedSession(JSON.stringify({ summary: "ok" }));
    await assert.rejects(
      () =>
        runVerification({
          verifierSession: session,
          worktreePath: runDir,
          runId: "run-1",
          runDir,
          expectedFenceEpoch: 0, // stale: actual current epoch is 1
          attemptId: "run-1-verify",
          // A command that would fail this test if it were ever actually run
          // (no such file/dir) -- proves the stale-fence short-circuit fires
          // before any harness work, not just before the model call.
          validationCommands: [{ command: "exit 0" }],
        }),
      StaleFenceError,
    );
    assert.equal(session.calls, 0, "a stale run must not even spend tokens");
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
          text: JSON.stringify({ summary: "looked fine" }),
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
          validationCommands: [{ command: "exit 0" }],
        }),
      StaleFenceError,
    );
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});
