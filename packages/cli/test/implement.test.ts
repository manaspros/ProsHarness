import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier, Journal } from "@pros/barrier";
import { parseImplementArgs, runImplementCommand } from "../src/implement.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-cli-impl-repo-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("parseImplementArgs: requires a run-id positional arg", () => {
  assert.throws(() => parseImplementArgs([]), /usage: pros implement <run-id>/);
});

test("parseImplementArgs: resolves config from env vars with the <HOME>/.pros/<name> fallback convention", () => {
  const args = parseImplementArgs(["my-run"], { HOME: "/home/tester" } as NodeJS.ProcessEnv);
  assert.equal(args.runId, "my-run");
  assert.equal(args.runsRoot, path.join("/home/tester", ".pros", "runs"));
  assert.equal(args.leaseDir, path.join("/home/tester", ".pros", "leases"));
  assert.equal(args.maxConcurrent, 3);
  assert.equal(args.maxTokensPerRun, 200_000);

  const overridden = parseImplementArgs(["my-run"], {
    HOME: "/home/tester",
    PROS_RUNS_DIR: "/custom/runs",
    PROS_LEASE_DIR: "/custom/leases",
    PROS_MAX_CONCURRENT: "5",
    PROS_MAX_TOKENS_PER_RUN: "12345",
  } as NodeJS.ProcessEnv);
  assert.equal(overridden.runsRoot, "/custom/runs");
  assert.equal(overridden.leaseDir, "/custom/leases");
  assert.equal(overridden.maxConcurrent, 5);
  assert.equal(overridden.maxTokensPerRun, 12345);
});

test("pros implement: refuses when no Gate 1 (plan_approval) checkpoint exists for the run", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-impl-runs-"));
  const runId = "impl-no-gate1";
  try {
    // A run directory with SOME journal history but no plan_approval checkpoint at all.
    const runDir = path.join(runsRoot, runId);
    const journal = await Journal.open(runDir);
    await journal.close();

    const env = { HOME: "/root", PROS_RUNS_DIR: runsRoot } as NodeJS.ProcessEnv;
    await assert.rejects(() => runImplementCommand([runId], env), /no Gate 1 \(plan_approval\) checkpoint found/);
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros implement: refuses when Gate 1 is parked but not yet answered", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-impl-runs2-"));
  const runId = "impl-not-answered";
  const runDir = path.join(runsRoot, runId);
  try {
    const barrier = await Barrier.open(runDir, runId);
    try {
      await barrier.parkForGate1({
        cwd: repo,
        prompt: "approve?",
        options: ["approve", "amend", "reject"],
        questionId: randomUUID(),
        idempotencyKey: randomUUID(),
        planRef: { planId: "plan-1", version: 1 },
      });
    } finally {
      await barrier.close();
    }

    const env = { HOME: "/root", PROS_RUNS_DIR: runsRoot } as NodeJS.ProcessEnv;
    await assert.rejects(() => runImplementCommand([runId], env), /is not yet answered/);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros implement: refuses on an amended/aborted Gate 1 answer, not just an unanswered one", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-impl-runs3-"));
  const runId = "impl-amended";
  const runDir = path.join(runsRoot, runId);
  try {
    const barrier = await Barrier.open(runDir, runId);
    try {
      const { checkpointId } = await barrier.parkForGate1({
        cwd: repo,
        prompt: "approve?",
        options: ["approve", "amend", "reject"],
        questionId: randomUUID(),
        idempotencyKey: randomUUID(),
        planRef: { planId: "plan-1", version: 1 },
      });
      const cp = barrier.getState().checkpoints.get(checkpointId)!;
      await barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, "amend", "requires_plan_amendment");
    } finally {
      await barrier.close();
    }

    const env = { HOME: "/root", PROS_RUNS_DIR: runsRoot } as NodeJS.ProcessEnv;
    await assert.rejects(() => runImplementCommand([runId], env), /not "continue_within_approved_plan"/);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pros implement: refuses to double-run Gate 2 when it has already been started for this run", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-impl-runs4-"));
  const runId = "impl-already-gate2";
  const runDir = path.join(runsRoot, runId);
  try {
    const barrier = await Barrier.open(runDir, runId);
    try {
      const { checkpointId } = await barrier.parkForGate1({
        cwd: repo,
        prompt: "approve?",
        options: ["approve", "amend", "reject"],
        questionId: randomUUID(),
        idempotencyKey: randomUUID(),
        planRef: { planId: "plan-1", version: 1 },
      });
      const cp = barrier.getState().checkpoints.get(checkpointId)!;
      await barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, "approve", "continue_within_approved_plan");
    } finally {
      await barrier.close();
    }

    // Simulate Gate 2 already having been kicked off: a pr_create_intent journal entry.
    const journal = await Journal.open(runDir);
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "pr_create_intent",
      prIntentId: randomUUID(),
      branch: "pros/impl-already-gate2/x",
      baseBranch: "main",
      idempotencyKey: `pr-${runId}`,
      repo: "acme/widgets",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    const env = { HOME: "/root", PROS_RUNS_DIR: runsRoot } as NodeJS.ProcessEnv;
    await assert.rejects(() => runImplementCommand([runId], env), /already been started or completed/);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
