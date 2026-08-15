import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Barrier } from "@pros/barrier";
import { submitPlan } from "../src/submit-plan.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-mcp-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("submit_plan: never resolves, and durably records a plan_approval checkpoint_requested entry", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), "pros-mcp-run-"));
  try {
    const barrier = await Barrier.open(runDir, "run-mcp-submit-1");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });

    const raced = await Promise.race([
      submitPlan(barrier, attemptId, { planId: "plan-1", version: 1, summary: "Do the thing" }).then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    assert.equal(raced, "timeout", "submit_plan must never resolve, even after its checkpoint has fully parked");

    const state = barrier.getState();
    const parked = [...state.checkpoints.values()].find((cp) => cp.phase === "parked");
    assert.ok(parked, "the barrier must have durably parked the run as a side effect of the call");
    assert.equal(parked!.gateType, "plan_approval");
    assert.deepEqual(parked!.planRef, { planId: "plan-1", version: 1 });

    await barrier.close();
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("bash", ["-c", "systemctl --user list-units --all --no-legend --plain 'pros-*' | awk '{print $1}' | xargs -r -I{} systemctl --user stop {}"]).catch(
      () => undefined,
    );
  }
});

test("submit_plan: idempotency -- calling twice with the same idempotencyKey never mints a second question", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), "pros-mcp-run-"));
  try {
    const barrier = await Barrier.open(runDir, "run-mcp-submit-idem");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });

    const idem = randomUUID();
    // Fire both calls without awaiting either (they never resolve) -- race
    // each against a short timeout just to let the barrier machinery run.
    void submitPlan(barrier, attemptId, { planId: "plan-1", version: 1, summary: "first", idempotencyKey: idem });
    await new Promise((r) => setTimeout(r, 500));
    void submitPlan(barrier, attemptId, { planId: "plan-1", version: 1, summary: "second (replay)", idempotencyKey: idem });
    await new Promise((r) => setTimeout(r, 500));

    const state = barrier.getState();
    const planApprovalCheckpoints = [...state.checkpoints.values()].filter((cp) => cp.gateType === "plan_approval");
    assert.equal(planApprovalCheckpoints.length, 1, "a replayed submit_plan call with the same idempotency key must not mint a second checkpoint");

    await barrier.close();
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("bash", ["-c", "systemctl --user list-units --all --no-legend --plain 'pros-*' | awk '{print $1}' | xargs -r -I{} systemctl --user stop {}"]).catch(
      () => undefined,
    );
  }
});
