import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Barrier, Journal } from "@pros/barrier";
import type { ModelRunOptions, ModelRunResult, ModelSession } from "@pros/plan";
import { createServer, type Server } from "node:http";
import { runPlanCommand } from "../src/plan.js";

const execFileAsync = promisify(execFile);

/**
 * A clone of a real bare "origin", not a bare local-only repo -- the
 * fresh-workspace-per-session feature (packages/worktree/src/fresh-base.ts,
 * wired into runPlanPipeline) fetches `origin` and resolves the workspace
 * against `origin/<default-branch>`, so every fixture repoRoot passed to the
 * real pipeline needs a real remote, exactly like packages/implement's
 * e2e-m4.test.ts/from-run.test.ts already do for the same reason.
 */
async function makeTempRepo(): Promise<{ repoRoot: string; bareRepoPath: string }> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-origin-"));
  const dir = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-repo-"));
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

/** A minimal deterministic fake ModelSession -- one canned response per call, indexed by call order. */
class FakeSession implements ModelSession {
  private i = 0;
  constructor(
    readonly provider: "claude" | "codex",
    private readonly responses: string[],
  ) {}
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    const text = this.responses[Math.min(this.i, this.responses.length - 1)]!;
    this.i += 1;
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

test("pros plan: end-to-end with fake sessions + a real worktree allocation", async () => {
  const { repoRoot, bareRepoPath } = await makeTempRepo();
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-runs-"));
  const runId = "run-cli-plan-1";

  const claudeSession = new FakeSession("claude", [
    // finding
    JSON.stringify({
      title: "off-by-one in loop",
      evidence: [{ file: "loop.ts", line: 1, snippet: "for (let i = 0; i <= arr.length; i++) {}" }],
      summary: "loop bound is inclusive when it should be exclusive",
    }),
    // draftPlan v1
    JSON.stringify({
      markdown: "# Plan\n\nFix the loop bound.",
      structured: { steps: ["fix bound"], filesTouched: ["loop.ts"], risk: "low" },
    }),
  ]);
  const codexSession = new FakeSession("codex", [
    // independentAssessment
    JSON.stringify({ approach: "fix the comparison operator", risks: ["none major"] }),
    // critiqueObjections round 1 -- no objections, converge immediately
    JSON.stringify({ objections: [] }),
  ]);

  try {
    const output = await runPlanCommand([repoRoot, "sumAll returns NaN for some inputs", `--run-id=${runId}`], {
      worktreesRoot,
      runsRoot,
      claudeSession,
      codexSession,
    });

    assert.match(output, /plan written:/);
    assert.match(output, /objections written:/);
    assert.match(output, /0 total/);

    const runDir = path.join(runsRoot, runId);
    const { entries } = await Journal.read(runDir);
    const kinds = entries.map((e) => e.kind);

    // A real worktree must have been allocated before any model call.
    assert.ok(kinds.includes("worktree_confirmed"));
    assert.ok(kinds.includes("finding_recorded"));
    assert.ok(kinds.includes("plan_drafted"));
    assert.ok(kinds.includes("critique_independent"));
    assert.ok(kinds.includes("critique_objections"));
    assert.ok(kinds.includes("plan_finalized"));
    assert.ok(!kinds.includes("debate_capped"), "converged naturally, should not be capped");

    // M3: the run must now ALSO be parked at Gate 1 -- runPlanPipeline wires
    // finding -> debate -> plan_finalized -> parkForGate1 end to end.
    assert.ok(kinds.includes("checkpoint_requested"));
    assert.ok(kinds.includes("parked"));
    assert.match(output, /checkpoint:/);
    assert.match(output, /awaiting Gate 1 approval/);
    const questionIdMatch = output.match(/pros answer (\S+)/);
    assert.ok(questionIdMatch, "output must print the questionId pros answer needs");

    const barrier = await Barrier.open(runDir, runId);
    try {
      const state = barrier.getState();
      const parkedCps = [...state.checkpoints.values()].filter((cp) => cp.phase === "parked");
      assert.equal(parkedCps.length, 1);
      assert.equal(parkedCps[0]!.gateType, "plan_approval");
      assert.equal(parkedCps[0]!.questionId, questionIdMatch![1]);
    } finally {
      await barrier.close();
    }

    const worktreeConfirmedIdx = kinds.indexOf("worktree_confirmed");
    const findingIdx = kinds.indexOf("finding_recorded");
    assert.ok(worktreeConfirmedIdx < findingIdx, "worktree must be allocated before the agent starts");

    const planPathMatch = output.match(/plan written: (.+)/);
    const objectionsPathMatch = output.match(/objections written: (.+)/);
    assert.ok(planPathMatch && objectionsPathMatch);
    const planMarkdown = await readFile(planPathMatch![1]!, "utf8");
    assert.ok(planMarkdown.length > 0);
    const objectionsJson = JSON.parse(await readFile(objectionsPathMatch![1]!, "utf8"));
    assert.deepEqual(objectionsJson.objections, []);
    assert.deepEqual(objectionsJson.unresolved, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * B8 regression: `runPlanCommand` used to hardcode
 * `notificationsEnabled: envOverrides.notificationsEnabled ?? false`, so no
 * environment variable existed anywhere that could turn Gate 1's
 * notification on. This proves the real CLI entry point (not just
 * `runPlanPipeline` called directly, which packages/plan/test/gate1-e2e.test.ts
 * already covers) reads `PROS_NOTIFICATIONS_ENABLED` and actually fires.
 */
test("pros plan: PROS_NOTIFICATIONS_ENABLED=1 makes the real CLI entry point fire the Gate 1 park notification", async () => {
  const { repoRoot, bareRepoPath } = await makeTempRepo();
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-notify-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-notify-runs-"));
  const runId = "run-cli-plan-notify-1";
  const previous = process.env.PROS_NOTIFICATIONS_ENABLED;
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

    process.env.PROS_NOTIFICATIONS_ENABLED = "1";

    const claudeSession = new FakeSession("claude", [
      JSON.stringify({
        title: "off-by-one in loop",
        evidence: [{ file: "loop.ts", line: 1, snippet: "for (let i = 0; i <= arr.length; i++) {}" }],
        summary: "loop bound is inclusive when it should be exclusive",
      }),
      JSON.stringify({
        markdown: "# Plan\n\nFix the loop bound.",
        structured: { steps: ["fix bound"], filesTouched: ["loop.ts"], risk: "low" },
      }),
    ]);
    const codexSession = new FakeSession("codex", [
      JSON.stringify({ approach: "fix the comparison operator", risks: ["none major"] }),
      JSON.stringify({ objections: [] }),
    ]);

    await runPlanCommand([repoRoot, "sumAll returns NaN for some inputs", `--run-id=${runId}`], {
      worktreesRoot,
      runsRoot,
      claudeSession,
      codexSession,
      ntfyUrl: `http://127.0.0.1:${address.port}/test-notification`,
    });

    const notificationOutcome = await Promise.race([
      requestReceived.then(() => "sent" as const),
      new Promise<"not-sent">((resolve) => setTimeout(() => resolve("not-sent"), 2000)),
    ]);
    assert.equal(notificationOutcome, "sent", "PROS_NOTIFICATIONS_ENABLED=1 must make the real CLI entry point notify");
  } finally {
    if (previous === undefined) delete process.env.PROS_NOTIFICATIONS_ENABLED;
    else process.env.PROS_NOTIFICATIONS_ENABLED = previous;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
