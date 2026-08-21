import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Barrier, Journal, loadRunState } from "@pros/barrier";
import { validateExitPlanModePayload, recordHookPayload } from "../src/exit-plan-mode-hook.js";
import { makeTempRepo } from "./git-fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures/hooks");

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES_DIR, name), "utf8");
}

async function makeRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pros-hook-run-"));
}

// --- 1. validateExitPlanModePayload against each fixture -----------------

test("validateExitPlanModePayload: valid.json is recognized as a valid ExitPlanMode payload", async () => {
  const raw = await readFixture("valid.json");
  const result = validateExitPlanModePayload(raw);
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.sessionId, "session-abc123");
  assert.equal(result.cwd, "/home/user/project");
  assert.ok(result.planMarkdown && result.planMarkdown.includes("Fix the flaky retry logic"));
});

test("validateExitPlanModePayload: missing-plan.json is invalid with a specific reason", async () => {
  const raw = await readFixture("missing-plan.json");
  const result = validateExitPlanModePayload(raw);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing tool_input.plan");
  assert.equal(result.planMarkdown, null);
});

test("validateExitPlanModePayload: wrong-tool.json is invalid with a specific reason", async () => {
  const raw = await readFixture("wrong-tool.json");
  const result = validateExitPlanModePayload(raw);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "wrong tool_name");
  assert.equal(result.planMarkdown, null);
});

test("validateExitPlanModePayload: malformed.json (not valid JSON) is invalid with a malformed-JSON reason", async () => {
  const raw = await readFixture("malformed.json");
  const result = validateExitPlanModePayload(raw);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /malformed JSON/);
  assert.equal(result.sessionId, null);
  assert.equal(result.cwd, null);
  assert.equal(result.planMarkdown, null);
});

test("validateExitPlanModePayload: an arbitrary non-JSON string never throws", () => {
  const result = validateExitPlanModePayload("not json at all { [ garbage");
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /malformed JSON/);
});

// --- 2. recordHookPayload against a real temp run dir ---------------------

test("recordHookPayload: valid fixture -> journal gets a hook_payload_received entry with valid:true", async () => {
  const runDir = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);
    await journal.append({ runId: "run-hook-1", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: runDir, launchConfigHash: "x", unitName: "u" });
    await journal.close();

    const raw = await readFixture("valid.json");
    await recordHookPayload({ runDir, runId: "run-hook-1", raw });

    const { entries } = await Journal.read(runDir);
    const hookEntries = entries.filter((e) => e.kind === "hook_payload_received");
    assert.equal(hookEntries.length, 1);
    const e = hookEntries[0] as Extract<(typeof entries)[number], { kind: "hook_payload_received" }>;
    assert.equal(e.valid, true);
    assert.equal(e.reason, null);
    assert.equal(e.hookName, "PostToolUse:ExitPlanMode");
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("recordHookPayload: malformed fixture -> journal gets an entry with valid:false and a reason, and the call still resolves", async () => {
  const runDir = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);
    await journal.append({ runId: "run-hook-2", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: runDir, launchConfigHash: "x", unitName: "u" });
    await journal.close();

    const raw = await readFixture("malformed.json");
    await recordHookPayload({ runDir, runId: "run-hook-2", raw }); // must not throw

    const { entries } = await Journal.read(runDir);
    const hookEntries = entries.filter((e) => e.kind === "hook_payload_received");
    assert.equal(hookEntries.length, 1);
    const e = hookEntries[0] as Extract<(typeof entries)[number], { kind: "hook_payload_received" }>;
    assert.equal(e.valid, false);
    assert.match(e.reason ?? "", /malformed JSON/);
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("recordHookPayload: nonexistent run dir resolves without throwing and does not create the directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pros-hook-parent-"));
  const nonexistentRunDir = path.join(parent, "does-not-exist-yet");
  try {
    const raw = await readFixture("valid.json");
    await recordHookPayload({ runDir: nonexistentRunDir, runId: "run-hook-3", raw }); // must not throw

    await assert.rejects(() => readFile(path.join(nonexistentRunDir, "journal.ndjson")), "the run dir must not have been created as a side effect");
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
});

// --- 3. The hook is never the sole source of plan truth --------------------

test("the hook payload alone can never park a run, and parkForGate1 alone is sufficient without the hook ever firing", async () => {
  // Scenario A: a Barrier reaches parked (plan_approval gate) via
  // parkForGate1 ALONE -- as if the ExitPlanMode hook never fired at all
  // (misconfigured, absent, whatever). This proves submit_plan/parkForGate1
  // is sufficient on its own.
  const repoA = await makeTempRepo();
  const runDirA = await makeRunDir();
  // Scenario B: a hook payload is recorded for a run where NO
  // submit_plan/parkForGate1 checkpoint was ever requested. This proves the
  // hook cannot fabricate a checkpoint or park a run by itself.
  const runDirB = await makeRunDir();

  try {
    const barrierA = await Barrier.open(runDirA, "run-gate1-a");
    const { checkpointId } = await barrierA.parkForGate1({
      cwd: repoA,
      prompt: "Plan v1 ready for review",
      options: ["approve", "amend", "reject"],
      questionId: "q-1",
      idempotencyKey: "idem-1",
      planRef: { planId: "plan-1", version: 1 },
    });
    const stateA = barrierA.getState();
    const cp = stateA.checkpoints.get(checkpointId);
    assert.ok(cp, "the checkpoint must exist");
    assert.equal(cp!.phase, "parked", "parkForGate1 alone must reach parked, with no hook payload ever recorded");
    assert.equal(cp!.gateType, "plan_approval");
    assert.equal(stateA.hookPayloads.length, 0, "no hook payload was ever recorded in this scenario");
    await barrierA.close();

    // Scenario B: record a hook payload for a run dir where parkForGate1 was
    // NEVER called.
    const journalB = await Journal.open(runDirB);
    await journalB.close();
    const raw = await readFixture("valid.json");
    await recordHookPayload({ runDir: runDirB, runId: "run-gate1-b", raw });

    const stateB = await loadRunState(runDirB);
    assert.equal(stateB.checkpoints.size, 0, "a hook payload alone must not create any checkpoint");
    assert.ok(
      ![...stateB.checkpoints.values()].some((c) => c.phase === "parked"),
      "a hook payload alone must never park a run",
    );
    assert.equal(stateB.hookPayloads.length, 1, "the hook payload IS recorded, purely as corroborating/audit evidence");
    assert.equal(stateB.hookPayloads[0]!.valid, true);
  } finally {
    await rm(repoA, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDirA, { recursive: true, force: true }).catch(() => undefined);
    await rm(runDirB, { recursive: true, force: true }).catch(() => undefined);
  }
});
