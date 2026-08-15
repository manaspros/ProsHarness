import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Journal } from "@pros/barrier";
import { getSessionActivity } from "../lib/session-activity.js";

test("getSessionActivity returns plain-language live Claude activity and follows operation completion", async () => {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-session-activity-"));
  const runDir = path.join(runsRoot, "run-1");
  const attemptDir = path.join(runDir, "attempts", "run-1-finding");
  try {
    const journal = await Journal.open(runDir);
    await journal.append({
      runId: "run-1",
      fenceEpoch: 0,
      kind: "plan_operation_started",
      operation: "plan_pipeline",
      requestedBy: "human",
      // The custom operation entry is intentionally outside the barrier union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, "provider.txt"), "claude\n");
    await writeFile(
      path.join(attemptDir, "raw.log"),
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }] } })}\n`,
    );

    const live = await getSessionActivity(runDir);
    assert.equal(live.active, true);
    assert.equal(live.operationLabel, "Building a plan");
    assert.equal(live.activity.at(-1)?.label, "Claude is exploring the codebase");
    assert.equal(live.activity.at(-1)?.detail, "src/app.ts");

    const completed = await Journal.open(runDir);
    await completed.append({
      runId: "run-1",
      fenceEpoch: 0,
      kind: "plan_operation_completed",
      operation: "plan_pipeline",
      outcome: "success",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await completed.close();

    const done = await getSessionActivity(runDir);
    assert.equal(done.active, false);
    assert.equal(done.activity.length, 1);
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});
