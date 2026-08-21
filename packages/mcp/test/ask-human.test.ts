import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier } from "@pros/barrier";
import { askHuman } from "../src/ask-human.js";
import { makeTempRepo } from "./git-fixture.js";

const execFileAsync = promisify(execFile);

test("ask_human: never resolves, and durably parks the run via the barrier", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), "pros-mcp-run-"));
  try {
    const barrier = await Barrier.open(runDir, "run-mcp-1");
    const { attemptId } = await barrier.startAttempt({
      launchConfig: { provider: "fixture", command: "sleep", args: ["30"], cwd: repo },
    });

    const raced = await Promise.race([
      askHuman(barrier, attemptId, { prompt: "continue?", options: ["yes", "no"] }).then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    assert.equal(raced, "timeout", "ask_human must never resolve, even after its checkpoint has fully parked");

    const state = barrier.getState();
    const parked = [...state.checkpoints.values()].find((cp) => cp.phase === "parked");
    assert.ok(parked, "the barrier must have durably parked the run as a side effect of the call");
    assert.equal(parked!.prompt, "continue?");

    await barrier.close();
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    await execFileAsync("bash", ["-c", "systemctl --user list-units --all --no-legend --plain 'pros-*' | awk '{print $1}' | xargs -r -I{} systemctl --user stop {}"]).catch(
      () => undefined,
    );
  }
});
