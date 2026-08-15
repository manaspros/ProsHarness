import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Journal } from "@pros/barrier";
import type { ModelRunOptions, ModelRunResult, ModelSession } from "@pros/plan";
import { runPlanCommand } from "../src/plan.js";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-cli-plan-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "loop.ts"), "for (let i = 0; i <= arr.length; i++) {}\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
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
  const repoRoot = await makeTempRepo();
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
    await rm(worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
