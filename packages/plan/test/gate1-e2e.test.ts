import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, rm, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier, StaleFenceError } from "@pros/barrier";
import { rebuildIndex } from "@pros/index";
import { runPlanPipeline } from "../src/pipeline.js";
import { editPlanDocument } from "../src/gate1.js";
import { ScriptedSession } from "./helpers.js";

const execFileAsync = promisify(execFile);

/**
 * The headline M3 acceptance suite: everything below drives the REAL
 * `runPlanPipeline` (real Barrier, real Journal, real filesystem, real git
 * repo, real WorktreeAllocator) end to end, with only the model calls
 * themselves faked out (ScriptedSession -- same fake as debate.test.ts,
 * fast and deterministic). This is deliberately NOT unit-testing each
 * package in isolation -- packages/plan/test/gate1.test.ts and
 * packages/notify/test/barrier-integration.test.ts already do that against
 * synthetic setups. The value this file adds is proving the same properties
 * hold when a run arrives at "parked" via the actual pipeline wiring.
 */

/**
 * A clone of a real bare "origin", not a bare local-only repo -- the
 * fresh-workspace-per-session feature (packages/worktree/src/fresh-base.ts,
 * wired into runPlanPipeline) fetches `origin` and resolves the workspace
 * against `origin/<default-branch>`, so every fixture repoRoot passed to the
 * real pipeline needs a real remote, exactly like packages/implement's
 * e2e-m4.test.ts/from-run.test.ts already do for the same reason.
 */
async function makeTempRepo(): Promise<{ repoRoot: string; bareRepoPath: string }> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-gate1-e2e-origin-"));
  const dir = await mkdtemp(path.join(tmpdir(), "pros-gate1-e2e-repo-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", "--bare", bareRepoPath]);
  await execFileAsync("git", ["clone", "-q", bareRepoPath, dir]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "loop.ts"), "for (let i = 0; i <= arr.length; i++) {}\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await execFileAsync("git", ["push", "-q", "origin", "main"], { cwd: dir });
  return { repoRoot: dir, bareRepoPath };
}

interface Scenario {
  repoRoot: string;
  bareRepoPath: string;
  worktreesRoot: string;
  runsRoot: string;
  runId: string;
  runDir: string;
}

async function makeScenario(runId: string): Promise<Scenario> {
  const { repoRoot, bareRepoPath } = await makeTempRepo();
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-gate1-e2e-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-gate1-e2e-runs-"));
  return { repoRoot, bareRepoPath, worktreesRoot, runsRoot, runId, runDir: path.join(runsRoot, runId) };
}

async function cleanupScenario(s: Scenario): Promise<void> {
  await rm(s.repoRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(s.bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  await rm(s.worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(s.runsRoot, { recursive: true, force: true }).catch(() => undefined);
}

function fakeSessions(): { claudeSession: ScriptedSession; codexSession: ScriptedSession } {
  const claudeSession = new ScriptedSession("claude", [
    // finding
    {
      text: JSON.stringify({
        title: "off-by-one in loop",
        evidence: [{ file: "loop.ts", line: 1, snippet: "for (let i = 0; i <= arr.length; i++) {}" }],
        summary: "loop bound is inclusive when it should be exclusive",
      }),
    },
    // draftPlan v1
    {
      text: JSON.stringify({
        markdown: "# Plan\n\nFix the loop bound.",
        structured: { steps: ["fix bound"], filesTouched: ["loop.ts"], risk: "low" },
      }),
    },
  ]);
  const codexSession = new ScriptedSession("codex", [
    // independentAssessment
    { text: JSON.stringify({ approach: "fix the comparison operator", risks: ["none major"] }) },
    // critiqueObjections round 1 -- no objections, converge immediately
    { text: JSON.stringify({ objections: [] }) },
  ]);
  return { claudeSession, codexSession };
}

test("runPlanPipeline: notifications are opt-in so synthetic or library runs cannot send external messages", async () => {
  const s = await makeScenario("run-e2e-notifications-opt-in-1");
  let server: Server | undefined;
  try {
    let resolveRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    server = createServer((_req, res) => {
      resolveRequest?.();
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const { claudeSession, codexSession } = fakeSessions();
    await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "synthetic test run must not notify a real destination",
      runId: s.runId,
      claudeSession,
      codexSession,
      // If the pipeline wires notifications implicitly, this local endpoint
      // receives the request. It keeps the regression test fully offline.
      ntfyUrl: `http://127.0.0.1:${address.port}/test-notification`,
    });

    const outcome = await Promise.race([
      requestReceived.then(() => "sent" as const),
      new Promise<"not-sent">((resolve) => setTimeout(() => resolve("not-sent"), 100)),
    ]);
    assert.equal(outcome, "not-sent", "a library/test pipeline must not send notifications without explicit opt-in");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await cleanupScenario(s);
  }
});

test("Gate 1 parks the run after plan_finalized, with a notification fired (that a broken ntfy target cannot block)", async () => {
  const s = await makeScenario("run-e2e-park-1");
  try {
    const { claudeSession, codexSession } = fakeSessions();
    const start = Date.now();
    const result = await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "sumAll returns NaN for some inputs",
      runId: s.runId,
      claudeSession,
      codexSession,
      // Guaranteed unreachable -- localhost port 1 refuses connections
      // immediately, but even a hanging target must not block the pipeline
      // (sendNtfy's own 5s default timeout would otherwise dominate).
      ntfyUrl: "http://127.0.0.1:1",
      notificationsEnabled: true,
    });
    const elapsed = Date.now() - start;

    // The whole pipeline (finding + debate + park + notify) must resolve in
    // a bounded time -- nowhere near sendNtfy's 5s timeout dominating it.
    assert.ok(elapsed < 8000, `runPlanPipeline took ${elapsed}ms -- should not hang on a broken ntfy target`);
    assert.equal(result.parked, true);
    assert.ok(result.checkpointId);
    assert.ok(result.questionId);

    const barrier = await Barrier.open(s.runDir, s.runId);
    try {
      const state = barrier.getState();
      const cp = state.checkpoints.get(result.checkpointId);
      assert.ok(cp, "checkpoint must exist");
      assert.equal(cp!.phase, "parked");
      assert.equal(cp!.gateType, "plan_approval");
      assert.deepEqual(cp!.planRef, { planId: result.debate.finalPlan.planId, version: result.debate.finalPlan.version });
    } finally {
      await barrier.close();
    }

    const { readManifest } = await import("@pros/barrier");
    const manifest = await readManifest(s.runDir);
    assert.ok(manifest, "manifest.json must exist");
    assert.equal(manifest!.cwd, result.worktreePath);
  } finally {
    await cleanupScenario(s);
  }
});

test("Kill the daemon mid-wait; the run still resumes", async () => {
  const s = await makeScenario("run-e2e-kill-daemon-1");
  try {
    const { claudeSession, codexSession } = fakeSessions();
    const result = await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "sumAll returns NaN for some inputs",
      runId: s.runId,
      claudeSession,
      codexSession,
    });
    assert.equal(result.parked, true);

    // "Kill the daemon": deliberately never reuse anything from the pipeline
    // call above (no in-memory Barrier, no closures over its state) -- open
    // a completely fresh Barrier against the same runDir, proving recovery
    // works purely from disk.
    const fresh1 = await Barrier.open(s.runDir, s.runId);
    let cwd: string;
    let attemptId: string;
    try {
      const state1 = fresh1.getState();
      const cp = state1.checkpoints.get(result.checkpointId);
      assert.ok(cp, "checkpoint must be recoverable from disk alone");
      assert.equal(cp!.phase, "parked", "checkpoint must still be parked after a fresh process attaches");

      await fresh1.recordAnswer(result.checkpointId, cp!.questionId, cp!.idempotencyKey, "approve", "continue_within_approved_plan");
      await fresh1.claim(result.checkpointId);
      const resumed = await fresh1.resume(result.checkpointId);
      cwd = resumed.cwd;
      attemptId = resumed.attemptId;
      assert.equal(cwd, result.worktreePath, "resume must launch from the manifest's recorded cwd");
      assert.ok(attemptId);
    } finally {
      await fresh1.close();
    }

    // Kill the daemon again -- a THIRD fresh Barrier confirms durability
    // survived two full "restarts": the checkpoint is now "resuming".
    const fresh2 = await Barrier.open(s.runDir, s.runId);
    try {
      const state2 = fresh2.getState();
      const cp2 = state2.checkpoints.get(result.checkpointId);
      assert.ok(cp2);
      assert.equal(cp2!.phase, "resuming", "the resume must be durable and visible to a brand new process/object");
    } finally {
      await fresh2.close();
    }
  } finally {
    await cleanupScenario(s);
  }
});

test("Plan editing changes the document without restarting the run", async () => {
  const s = await makeScenario("run-e2e-edit-1");
  try {
    const { claudeSession, codexSession } = fakeSessions();
    const result = await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "sumAll returns NaN for some inputs",
      runId: s.runId,
      claudeSession,
      codexSession,
    });
    assert.equal(result.parked, true);

    const beforeBarrier = await Barrier.open(s.runDir, s.runId);
    const beforeCp = beforeBarrier.getState().checkpoints.get(result.checkpointId)!;
    const fenceEpochBefore = beforeBarrier.getState().fenceEpoch;
    await beforeBarrier.close();

    const newMarkdown = "# Plan (edited by human)\n\nAdded a missing regression test step.\n";
    await editPlanDocument({
      runDir: s.runDir,
      runId: s.runId,
      planId: beforeCp.planRef!.planId,
      version: beforeCp.planRef!.version,
      markdown: newMarkdown,
      editedBy: "human",
    });

    const onDisk = await readFile(result.planMarkdownPath, "utf8");
    assert.equal(onDisk, newMarkdown, "plan.md must reflect the human edit");

    const afterBarrier = await Barrier.open(s.runDir, s.runId);
    try {
      const afterState = afterBarrier.getState();
      const afterCp = afterState.checkpoints.get(result.checkpointId)!;
      assert.equal(afterCp.phase, "parked", "editing must not move the checkpoint off parked");
      assert.equal(afterState.fenceEpoch, fenceEpochBefore, "editing must not bump the fence epoch");

      const { Journal } = await import("@pros/barrier");
      const { entries } = await Journal.read(s.runDir);
      assert.ok(
        !entries.some((e) => e.kind === "attempt_started" && e.attemptId !== "gate1-pipeline"),
        "no new real attempt started as a side effect of editing",
      );
      assert.ok(!entries.some((e) => e.kind === "resuming"), "editing must never trigger a resume");
      assert.ok(!entries.some((e) => e.kind === "consumed"), "editing must never trigger a consume");
    } finally {
      await afterBarrier.close();
    }
  } finally {
    await cleanupScenario(s);
  }
});

test("Fence epoch: a stale pre-approval result cannot reach a post-approval stage", async () => {
  const s = await makeScenario("run-e2e-fence-1");
  try {
    const { claudeSession, codexSession } = fakeSessions();
    const result = await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "sumAll returns NaN for some inputs",
      runId: s.runId,
      claudeSession,
      codexSession,
    });

    const barrier = await Barrier.open(s.runDir, s.runId);
    try {
      const cp = barrier.getState().checkpoints.get(result.checkpointId)!;
      const epochBeforeAnswer = barrier.getState().fenceEpoch;

      // requires_plan_amendment bumps the fence epoch (Barrier.recordAnswer).
      await barrier.recordAnswer(result.checkpointId, cp.questionId, cp.idempotencyKey, "amend", "requires_plan_amendment");
      assert.ok(barrier.fence.current() > epochBeforeAnswer, "the amendment must bump the fence epoch");

      // A stale, already-in-flight "verification result"/"PR op" from before
      // the amendment must be rejected, never silently allowed to proceed
      // as if nothing changed.
      await assert.rejects(
        () => barrier.fence.check(epochBeforeAnswer, "some-post-approval-op"),
        StaleFenceError,
      );
    } finally {
      await barrier.close();
    }
  } finally {
    await cleanupScenario(s);
  }
});

test("Unknown/unparsed events surface, never look healthy", async () => {
  const s = await makeScenario("run-e2e-health-1");
  try {
    const { claudeSession, codexSession } = fakeSessions();
    await runPlanPipeline({
      repoRoot: s.repoRoot,
      worktreesRoot: s.worktreesRoot,
      runsRoot: s.runsRoot,
      description: "sumAll returns NaN for some inputs",
      runId: s.runId,
      claudeSession,
      codexSession,
    });

    // Neither finding.ts/plan.ts/critique.ts pass a rawLogPath to
    // ModelSession.run() today (grep confirms it), so the pipeline never
    // produces attempts/<id>/raw.log on its own. Create one by hand with one
    // clearly-malformed line and one clearly-well-formed-but-unrecognized
    // line, per the brief.
    const attemptDir = path.join(s.runDir, "attempts", "synthetic");
    await mkdir(attemptDir, { recursive: true });
    const rawLogPath = path.join(attemptDir, "raw.log");
    await appendFile(rawLogPath, "{not valid json at all\n");
    await appendFile(rawLogPath, JSON.stringify({ type: "some_never_seen_event_type", data: 1 }) + "\n");

    const dbPath = path.join(s.runsRoot, "index.sqlite");
    const report = await rebuildIndex(dbPath, s.runsRoot);

    const issuesForRun = report.rawLogParseIssues.filter((i) => i.runId === s.runId);
    assert.ok(issuesForRun.some((i) => i.status === "malformed"), "the malformed line must be reported as malformed");
    assert.ok(issuesForRun.some((i) => i.status === "unknown_type"), "the unrecognized-type line must be reported as unknown_type");

    // Equivalent to @pros/dashboard's lib/health.ts rebuildHealthIssues/
    // isHealthy (a run with any rawLogParseIssues entry is never healthy) --
    // asserted directly here against @pros/index's RebuildReport rather than
    // pulling @pros/dashboard (a UI package) in as a devDependency of
    // @pros/plan (a backend package), which would be a backwards layering
    // edge. See docs/06-m3-implementation-log.md for the reasoning; the two
    // functions are one-line wrappers around exactly this data.
    const isHealthy = issuesForRun.length === 0;
    assert.equal(isHealthy, false, "a run with a raw log parse issue must never look healthy");
  } finally {
    await cleanupScenario(s);
  }
});
