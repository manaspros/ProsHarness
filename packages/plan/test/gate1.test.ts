import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier, Journal } from "@pros/barrier";
import { editPlanDocument } from "../src/gate1.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-gate1-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("editPlanDocument: changes plan.md and records plan_edited WITHOUT restarting the run", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), "pros-gate1-run-"));
  const runId = "run-gate1-edit-1";
  try {
    // Simulate a finished `pros plan` run awaiting Gate 1 approval.
    const barrier = await Barrier.open(runDir, runId);
    const { checkpointId } = await barrier.parkForGate1({
      cwd: repo,
      prompt: "Plan v1 ready for review",
      options: ["approve", "amend", "reject"],
      questionId: "q-edit-1",
      idempotencyKey: "idem-edit-1",
      planRef: { planId: "plan-1", version: 1 },
    });

    const beforeState = barrier.getState();
    const beforeEntryCount = (await Journal.read(runDir)).entries.length;
    const beforeCp = beforeState.checkpoints.get(checkpointId)!;
    assert.equal(beforeCp.phase, "parked");
    const fenceEpochBefore = beforeState.fenceEpoch;
    await barrier.close();

    const newMarkdown = "# Plan v1 (edited)\n\nA human added a missing step here.\n";
    await editPlanDocument({
      runDir,
      runId,
      planId: "plan-1",
      version: 1,
      markdown: newMarkdown,
      editedBy: "human",
      note: "added missing step",
    });

    // 1. plan.md on disk now contains the new markdown.
    const onDisk = await readFile(path.join(runDir, "plan.md"), "utf8");
    assert.equal(onDisk, newMarkdown);

    // 2. a plan_edited entry is in the journal.
    const { entries } = await Journal.read(runDir);
    assert.equal(entries.length, beforeEntryCount + 1, "editing the plan must append exactly one new journal entry");
    const editedEntries = entries.filter((e) => e.kind === "plan_edited");
    assert.equal(editedEntries.length, 1);
    const edited = editedEntries[0] as Extract<(typeof entries)[number], { kind: "plan_edited" }>;
    assert.equal(edited.markdown, newMarkdown);
    assert.equal(edited.editedBy, "human");
    assert.equal(edited.planId, "plan-1");
    assert.equal(edited.version, 1);

    // 3. the checkpoint's phase is STILL "parked" (unchanged).
    const afterBarrier = await Barrier.open(runDir, runId);
    const afterState = afterBarrier.getState();
    const afterCp = afterState.checkpoints.get(checkpointId)!;
    assert.equal(afterCp.phase, "parked", "editing the plan must not move the checkpoint off parked");

    // 4. the fence epoch is UNCHANGED.
    assert.equal(afterState.fenceEpoch, fenceEpochBefore, "editing the plan must not bump the fence epoch");

    // 5. no new attempt_started/resuming/consumed entry anywhere in the
    // journal -- nothing about the run's execution state moved.
    assert.ok(
      !entries.some((e) => e.kind === "attempt_started" && e.attemptId !== "gate1-pipeline"),
      "no new real attempt was started as a side effect of editing the plan",
    );
    assert.ok(!entries.some((e) => e.kind === "resuming"), "editing the plan must never trigger a resume");
    assert.ok(!entries.some((e) => e.kind === "consumed"), "editing the plan must never trigger a consume");

    await afterBarrier.close();
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
