import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier } from "@pros/barrier";
import { wireNtfyNotifications } from "../src/wire-barrier.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-notify-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * The closest thing to the explicit M3 acceptance criterion: a real Barrier,
 * wired to a real (but guaranteed-unreachable) ntfy target, must still park
 * a checkpoint without the park sequence being prevented or delayed by the
 * notification. This proves the whole point of onParked being fire-and-
 * forget, exercised against the actual Barrier implementation rather than
 * just the structural fake used in wire-barrier.test.ts.
 */
test("wireNtfyNotifications against a real Barrier: an unreachable ntfy target does not prevent or delay parkForGate1 completing", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), "pros-notify-run-"));
  const runId = "run-notify-integration-1";
  try {
    const barrier = await Barrier.open(runDir, runId);
    const unsubscribe = wireNtfyNotifications(barrier, { url: "http://127.0.0.1:1" });
    try {
      const start = Date.now();
      const { checkpointId } = await barrier.parkForGate1({
        cwd: repo,
        prompt: "Plan v1 ready for review",
        options: ["approve", "amend", "reject"],
        questionId: "q-notify-1",
        idempotencyKey: "idem-notify-1",
        planRef: { planId: "plan-notify-1", version: 1 },
      });
      const elapsed = Date.now() - start;

      // parkForGate1 does not itself await onParked listeners (they're fired
      // via a detached microtask inside Barrier.fireParked), so this must
      // resolve fast regardless of what the unreachable ntfy target does.
      assert.ok(elapsed < 2000, `parkForGate1 took ${elapsed}ms -- should not be delayed by ntfy`);

      const state = barrier.getState();
      const cp = state.checkpoints.get(checkpointId);
      assert.ok(cp, "checkpoint must exist");
      assert.equal(cp!.phase, "parked", "the checkpoint must reach parked phase despite the ntfy push failing");
    } finally {
      unsubscribe();
      await barrier.close();
    }
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
