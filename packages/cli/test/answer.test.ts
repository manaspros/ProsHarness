import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier } from "@pros/barrier";
import { runAnswerCommand, findRunForQuestion } from "../src/answer.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-cli-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("pros answer: finds the parked question by id and records the answer with its declared effect", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-runs-"));
  const runId = "run-cli-1";
  const runDir = path.join(runsRoot, runId);
  const prevRoot = process.env.PROS_RUNS_DIR;
  process.env.PROS_RUNS_DIR = runsRoot;
  try {
    const barrier = await Barrier.open(runDir, runId);
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const questionId = randomUUID();
    await barrier.requestCheckpoint({
      attemptId,
      questionId,
      idempotencyKey: randomUUID(),
      prompt: "which approach?",
      options: ["A", "B"],
    });
    await barrier.close();

    const found = await findRunForQuestion(runsRoot, questionId);
    assert.ok(found);
    assert.equal(found!.runId, runId);

    const result = await runAnswerCommand([questionId, "A", "--effect=continue_within_approved_plan"], );
    assert.match(result, /answered/);

    const after = await Barrier.open(runDir, runId);
    const cp = [...after.getState().checkpoints.values()][0]!;
    assert.equal(cp.answer, "A");
    assert.equal(cp.effect, "continue_within_approved_plan");
    assert.equal(cp.phase, "answered");
    await after.close();
  } finally {
    process.env.PROS_RUNS_DIR = prevRoot;
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("bash", ["-c", "systemctl --user list-units --all --no-legend --plain 'pros-*' | awk '{print $1}' | xargs -r -I{} systemctl --user stop {}"]).catch(
      () => undefined,
    );
  }
});

test("pros answer: a second answer for the same question id is rejected once claimed", async () => {
  const repo = await makeTempRepo();
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-runs2-"));
  const runId = "run-cli-2";
  const runDir = path.join(runsRoot, runId);
  const prevRoot = process.env.PROS_RUNS_DIR;
  process.env.PROS_RUNS_DIR = runsRoot;
  try {
    const barrier = await Barrier.open(runDir, runId);
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });
    const questionId = randomUUID();
    const { checkpointId } = await barrier.requestCheckpoint({
      attemptId,
      questionId,
      idempotencyKey: randomUUID(),
      prompt: "which approach?",
      options: ["A", "B"],
    });
    await barrier.close();

    await runAnswerCommand([questionId, "A"]);

    const after = await Barrier.open(runDir, runId);
    await after.claim(checkpointId);
    await after.close();

    await assert.rejects(() => runAnswerCommand([questionId, "B"]));
  } finally {
    process.env.PROS_RUNS_DIR = prevRoot;
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("bash", ["-c", "systemctl --user list-units --all --no-legend --plain 'pros-*' | awk '{print $1}' | xargs -r -I{} systemctl --user stop {}"]).catch(
      () => undefined,
    );
  }
});
