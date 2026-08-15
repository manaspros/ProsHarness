#!/usr/bin/env tsx
/**
 * scripts/seed-demo.ts -- populates a human-visible demo dataset by driving
 * the REAL pipeline functions (`runPlanPipeline`, `runGate2Pipeline`, the
 * real `Barrier`/`Journal`, the real `WorktreeAllocator`, a real local git
 * repo + bare "origin") with only the `claude`/`codex` subprocess calls
 * faked -- exactly the pattern `packages/plan/test/gate1-e2e.test.ts` and
 * `packages/implement/test/pipeline.test.ts` already use. No hand-fabricated
 * SQLite rows or journal entries: the on-disk journal is the only thing
 * written directly by "fake" code here, and only via the same
 * `Journal`/`Barrier`/pipeline APIs the rest of the system uses.
 *
 * Run via `pnpm run seed:demo` (or `tsx scripts/seed-demo.ts` directly).
 *
 * Safe by default: every env var below defaults to the SAME location the
 * real dashboard/CLI use (see docs/11-project-status.md's env var table),
 * so seeded runs show up in the exact dashboard a human would actually run
 * -- but every seeded run id is prefixed `demo-`, which is what makes
 * `seed-reset.ts` safe to run later without risking real data.
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { Barrier } from "@pros/barrier";
import { runPlanPipeline, type ModelSession, type ModelRunOptions, type ModelRunResult, type ModelUsage, type Objection } from "@pros/plan";
import { runGate2Pipeline, deriveGate2OptionsFromRun, LocalGhStub, type ScopedGhCredential } from "@pros/implement";
import { rebuildIndex } from "@pros/index";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config -- same defaults as docs/11-project-status.md, so seeded runs show
// up in the exact dashboard/CLI a human would actually run against.
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const RUNS_DIR = process.env.PROS_RUNS_DIR ?? path.join(HOME, ".pros", "runs");
const WORKTREES_DIR = process.env.PROS_WORKTREES_DIR ?? path.join(HOME, ".pros", "worktrees");
const INDEX_DB = process.env.PROS_INDEX_DB ?? path.join(HOME, ".pros", "index.sqlite");
const DEMO_REPO_ROOT = process.env.PROS_DEMO_REPO_ROOT ?? path.join(HOME, ".pros", "demo-repo");
const DEMO_REPO_ORIGIN = `${DEMO_REPO_ROOT}-origin.git`;

/** ProsHarness's own installation root (this repo) -- NOT the demo target repo. Needed to load `.claude/agents/scoped-fixer.md` and `.claude/skills/review/SKILL.md`, exactly like `Gate2PipelineOptions.repoRoot`'s doc comment requires. */
const PROSHARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RUN_ID_PARKED = "demo-parked-gate1";
const RUN_ID_COMPLETED = "demo-completed";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Demo repo: a small, real git repo with two real, plausible bugs, plus a
// real bare "origin" remote so LocalGhStub's push-based draft-PR flow works
// (mirrors packages/implement/test/pipeline.test.ts's makeRepoScenario).
// Idempotent: does nothing if the repo already exists.
// ---------------------------------------------------------------------------

const SUM_ALL_BUGGY = `export function sumAll(nums: number[]): number {
  let total = 0;
  for (let i = 0; i <= nums.length; i++) {
    total += nums[i];
  }
  return total;
}
`;

const PARSE_CONFIG_BUGGY = `export interface AppConfig {
  settings?: { theme: string };
}

export function parseConfig(raw: string): string {
  const config = JSON.parse(raw) as AppConfig;
  return config.settings.theme;
}
`;

const PARSE_CONFIG_FIXED = `export interface AppConfig {
  settings?: { theme: string };
}

export function parseConfig(raw: string): string {
  const config = JSON.parse(raw) as AppConfig;
  return config.settings?.theme ?? "light";
}
`;

async function ensureDemoRepo(): Promise<void> {
  if (await pathExists(DEMO_REPO_ROOT)) {
    console.log(`[seed-demo] demo repo already exists at ${DEMO_REPO_ROOT} -- leaving it as-is (idempotent).`);
    return;
  }

  console.log(`[seed-demo] creating demo repo at ${DEMO_REPO_ROOT} (+ bare origin at ${DEMO_REPO_ORIGIN})`);
  await mkdir(path.dirname(DEMO_REPO_ROOT), { recursive: true });

  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", DEMO_REPO_ORIGIN]);
  await execFileAsync("git", ["clone", "-q", DEMO_REPO_ORIGIN, DEMO_REPO_ROOT]);
  await git(DEMO_REPO_ROOT, ["config", "user.email", "demo@pros.local"]);
  await git(DEMO_REPO_ROOT, ["config", "user.name", "Pros Demo"]);

  await mkdir(path.join(DEMO_REPO_ROOT, "src"), { recursive: true });
  await writeFile(path.join(DEMO_REPO_ROOT, "src", "sumAll.ts"), SUM_ALL_BUGGY);
  await writeFile(path.join(DEMO_REPO_ROOT, "src", "parseConfig.ts"), PARSE_CONFIG_BUGGY);
  await writeFile(
    path.join(DEMO_REPO_ROOT, "README.md"),
    "# pros-demo-repo\n\nA small demo repository used only by ProsHarness's `pnpm run seed:demo` script. Contains two deliberately real, plausible bugs (`src/sumAll.ts`, `src/parseConfig.ts`) that the seeded demo runs cite as findings.\n",
  );

  await git(DEMO_REPO_ROOT, ["add", "."]);
  await git(DEMO_REPO_ROOT, ["commit", "-q", "-m", "init: demo repo with two seeded bugs"]);
  await git(DEMO_REPO_ROOT, ["push", "-q", "origin", "main"]);
}

// ---------------------------------------------------------------------------
// Raw-log sidecars, so the dashboard's session graph (packages/dashboard/
// lib/graph-data.ts) has something non-empty to render. Neither pipeline
// writes attempts/<id>/raw.log on its own (ModelRunOptions.rawLogPath is
// optional and unset by the pipelines below) -- so every fake ModelSession
// here writes one by hand right after producing its response, same as
// packages/dashboard/test/graph-data.test.ts does.
// ---------------------------------------------------------------------------

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

function claudeRawLines(tools: ToolCall[], resultText: string): string[] {
  const lines: unknown[] = [{ type: "system", subtype: "init", model: "claude-opus-4-6" }];
  tools.forEach((t, i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i + 1}`, name: t.name, input: t.input }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i + 1}`, content: "ok" }] } });
  });
  lines.push({ type: "result", subtype: "success", is_error: false, result: resultText.slice(0, 200) });
  return lines.map((l) => JSON.stringify(l));
}

function codexRawLines(command: string): string[] {
  return [
    { type: "thread.started", thread_id: randomUUID() },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "command_execution", command } },
    { type: "turn.completed" },
  ].map((l) => JSON.stringify(l));
}

async function writeRawLog(runDir: string, attemptId: string, provider: "claude" | "codex", lines: string[]): Promise<void> {
  const dir = path.join(runDir, "attempts", attemptId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "provider.txt"), provider);
  await writeFile(path.join(dir, "raw.log"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Fake ModelSessions -- scripted responses (Gate 1's finding/draft/assess/
// critique/revise calls, one per DemoSession.run() call in order), each also
// writing a realistic raw.log sidecar for the graph.
// ---------------------------------------------------------------------------

interface ScriptedStep {
  text: string;
  usage?: ModelUsage;
  tools?: ToolCall[];
  command?: string;
}

class DemoSession implements ModelSession {
  readonly provider: "claude" | "codex";
  private idx = 0;

  constructor(provider: "claude" | "codex", private readonly runDir: string, private readonly steps: ScriptedStep[]) {
    this.provider = provider;
  }

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const step = this.steps[this.idx];
    if (!step) throw new Error(`DemoSession(${this.provider}): no scripted step for call index ${this.idx} (attemptId=${opts.attemptId})`);
    this.idx++;
    const lines =
      this.provider === "claude" ? claudeRawLines(step.tools ?? [], step.text) : codexRawLines(step.command ?? "pnpm test");
    await writeRawLog(this.runDir, opts.attemptId, this.provider, lines);
    return { text: step.text, usage: step.usage ?? { inputTokens: 400, outputTokens: 220 } };
  }
}

/**
 * Drives Gate 2's implement + ultrareview stages for one `ClaudeStageSession`
 * -shaped fake (same split as packages/implement/test/pipeline.test.ts),
 * except this one commits a REAL, readable fix into `src/parseConfig.ts`
 * rather than a throwaway file.
 */
class ImplementSession implements ModelSession {
  readonly provider = "claude" as const;

  constructor(
    private readonly runDir: string,
    private readonly worktreePath: string,
    private readonly ultrareviewObjections: Objection[],
  ) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    if (opts.attemptId.endsWith("-implement")) {
      const filePath = path.join(this.worktreePath, "src", "parseConfig.ts");
      await writeFile(filePath, PARSE_CONFIG_FIXED);
      await execFileAsync("git", ["add", "."], { cwd: this.worktreePath });
      await execFileAsync("git", ["commit", "-q", "-m", "fix: guard against missing settings in parseConfig"], { cwd: this.worktreePath });
      await execFileAsync("git", ["push", "-q", "origin", "HEAD"], { cwd: this.worktreePath });

      const text = "Implemented the fix: parseConfig now guards the optional `settings` field with optional chaining and a default theme.";
      await writeRawLog(
        this.runDir,
        opts.attemptId,
        "claude",
        claudeRawLines(
          [
            { name: "Read", input: { file_path: "src/parseConfig.ts" } },
            {
              name: "Edit",
              input: {
                file_path: "src/parseConfig.ts",
                old_string: "return config.settings.theme;",
                new_string: 'return config.settings?.theme ?? "light";',
              },
            },
            { name: "Bash", input: { command: "git commit -m 'fix: guard against missing settings in parseConfig'" } },
          ],
          text,
        ),
      );
      return { text, usage: { inputTokens: 900, outputTokens: 400 } };
    }

    if (opts.attemptId.endsWith("-ultrareview")) {
      const text = JSON.stringify({ objections: this.ultrareviewObjections });
      await writeRawLog(this.runDir, opts.attemptId, "claude", claudeRawLines([{ name: "Bash", input: { command: "git diff main" } }], text));
      return { text, usage: { inputTokens: 300, outputTokens: 150 } };
    }

    throw new Error(`ImplementSession: unexpected attemptId ${opts.attemptId}`);
  }
}

class CodexReviewSession implements ModelSession {
  readonly provider = "codex" as const;
  constructor(private readonly runDir: string, private readonly objections: Objection[] = []) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const text = JSON.stringify({ objections: this.objections });
    await writeRawLog(this.runDir, opts.attemptId, "codex", codexRawLines("pnpm -r typecheck && pnpm -r test"));
    return { text, usage: { inputTokens: 250, outputTokens: 120 } };
  }
}

class VerifierSession implements ModelSession {
  readonly provider = "claude" as const;
  constructor(
    private readonly runDir: string,
    private readonly verdict: { outcome: "pass" | "fail"; summary: string; failingChecks: string[] },
  ) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const text = JSON.stringify(this.verdict);
    await writeRawLog(
      this.runDir,
      opts.attemptId,
      "claude",
      claudeRawLines([{ name: "Bash", input: { command: "pnpm -r typecheck && pnpm -r test" } }], text),
    );
    return { text, usage: { inputTokens: 350, outputTokens: 90 } };
  }
}

// ---------------------------------------------------------------------------
// Run 1 -- demo-parked-gate1: finding -> plan -> Codex objection -> revision
// -> plan_finalized, then PARKED at Gate 1 (never answered).
// ---------------------------------------------------------------------------

const MAJOR_CLAIM =
  "The plan doesn't address what sumAll should return for an empty array -- the fixed loop bound is correct, but there's no explicit test/spec for the empty-array case, which is exactly the edge a reviewer will ask about.";
const MINOR_CLAIM =
  "The plan doesn't mention auditing call sites that may have been silently relying on the old truncated/NaN behavior.";

async function seedParkedRun(): Promise<{ runId: string; questionId: string; checkpointId: string } | { runId: string; existing: true }> {
  const runDir = path.join(RUNS_DIR, RUN_ID_PARKED);
  if (await pathExists(runDir)) {
    console.log(`[seed-demo] run ${RUN_ID_PARKED} already exists -- skipping (idempotent).`);
    return { runId: RUN_ID_PARKED, existing: true };
  }

  const claudeSession = new DemoSession("claude", runDir, [
    // finding
    {
      text: JSON.stringify({
        title: "sumAll returns NaN due to an off-by-one loop bound",
        evidence: [{ file: "src/sumAll.ts", line: 3, snippet: "for (let i = 0; i <= nums.length; i++) {" }],
        summary:
          "The loop condition uses <= instead of < against nums.length, so the last iteration reads nums[nums.length], which is undefined. undefined + number is NaN, corrupting the running total for every non-empty array.",
      }),
      tools: [{ name: "Read", input: { file_path: "src/sumAll.ts" } }],
    },
    // draftPlan v1
    {
      text: JSON.stringify({
        markdown:
          "# Plan: fix off-by-one in sumAll\n\n## Steps\n1. Change the loop condition in `src/sumAll.ts` from `i <= nums.length` to `i < nums.length`.\n2. Add a regression test covering a non-trivial array.\n\n## Risk\nLow -- single-line change, well covered by a direct test.",
        structured: { steps: ["Fix loop bound in sumAll", "Add regression test"], filesTouched: ["src/sumAll.ts"], risk: "low" },
      }),
      tools: [{ name: "Read", input: { file_path: "src/sumAll.ts" } }],
    },
    // revisePlan r1 -- accepts the major objection, leaves the minor one as an accepted risk
    {
      text: JSON.stringify({
        markdown:
          "# Plan: fix off-by-one in sumAll (revised)\n\n## Steps\n1. Change the loop condition in `src/sumAll.ts` from `i <= nums.length` to `i < nums.length`.\n2. Add regression tests covering a normal array AND the empty-array case (`sumAll([]) === 0`).\n\n## Objection responses\n- [major] Missing empty-array case: **accepted** -- added an explicit test for `sumAll([])`.\n- [minor] Call-site audit: **accepted as a known risk**, not addressed in this pass -- flagged for the human reviewer at Gate 1 rather than expanding scope here.\n\n## Risk\nLow -- single-line change plus tests.",
        structured: {
          steps: ["Fix loop bound in sumAll", "Add regression test for a normal array", "Add regression test for the empty-array case"],
          filesTouched: ["src/sumAll.ts"],
          risk: "low",
          objectionResolutions: [{ claim: MAJOR_CLAIM, resolution: "accepted", note: "Added an explicit empty-array test." }],
        },
      }),
      tools: [{ name: "Edit", input: { file_path: "src/sumAll.ts", old_string: "i <= nums.length", new_string: "i < nums.length" } }],
    },
  ]);

  const codexSession = new DemoSession("codex", runDir, [
    // independentAssessment
    {
      text: JSON.stringify({
        approach: "Fix the loop bound and add tests for both a typical array and the empty-array edge case.",
        risks: ["Off-by-one errors like this often hide a second untested edge (empty input)", "Call sites may depend on the buggy truncated sum"],
      }),
      command: "rg -n 'sumAll' src",
    },
    // critiqueObjections round 1 -- one major, one minor
    {
      text: JSON.stringify({
        objections: [
          { severity: "major", claim: MAJOR_CLAIM, suggested_change: "Add an explicit note/test for sumAll([]) === 0." },
          { severity: "minor", claim: MINOR_CLAIM, suggested_change: "Grep for sumAll's call sites and note whether any assumed the buggy behavior." },
        ],
      }),
      command: "pnpm test",
    },
  ]);

  console.log(`[seed-demo] running Gate 1 pipeline for ${RUN_ID_PARKED} ...`);
  const result = await runPlanPipeline({
    repoRoot: DEMO_REPO_ROOT,
    worktreesRoot: WORKTREES_DIR,
    runsRoot: RUNS_DIR,
    description: "sumAll() returns NaN for some inputs -- looks like an off-by-one loop bound",
    runId: RUN_ID_PARKED,
    claudeSession,
    codexSession,
  });

  console.log(`[seed-demo] ${RUN_ID_PARKED} parked at Gate 1 (checkpoint ${result.checkpointId}, question ${result.questionId})`);
  return { runId: RUN_ID_PARKED, questionId: result.questionId, checkpointId: result.checkpointId };
}

// ---------------------------------------------------------------------------
// Run 2 -- demo-completed: finding -> plan -> plan_finalized (no objections)
// -> Gate 1 approved for real -> Gate 2 (implement -> verify -> review ->
// draft PR) -> parked at Gate 2.
// ---------------------------------------------------------------------------

async function seedCompletedRun(): Promise<
  { runId: string; prUrl: string; prNumber: number } | { runId: string; existing: true }
> {
  const runDir = path.join(RUNS_DIR, RUN_ID_COMPLETED);
  if (await pathExists(runDir)) {
    console.log(`[seed-demo] run ${RUN_ID_COMPLETED} already exists -- skipping (idempotent).`);
    return { runId: RUN_ID_COMPLETED, existing: true };
  }

  const claudeSession = new DemoSession("claude", runDir, [
    // finding
    {
      text: JSON.stringify({
        title: "parseConfig throws when settings is missing",
        evidence: [{ file: "src/parseConfig.ts", line: 7, snippet: "return config.settings.theme;" }],
        summary:
          "parseConfig accesses config.settings.theme without checking whether settings is present. AppConfig marks settings as optional, so any config JSON that omits it causes a TypeError at runtime instead of falling back to a sane default.",
      }),
      tools: [{ name: "Read", input: { file_path: "src/parseConfig.ts" } }],
    },
    // draftPlan v1
    {
      text: JSON.stringify({
        markdown:
          "# Plan: guard parseConfig against missing settings\n\n## Steps\n1. Change `src/parseConfig.ts` to use optional chaining (`config.settings?.theme`) with a default of \"light\".\n2. Add a regression test for a config payload with no `settings` key.\n\n## Risk\nLow -- narrow, additive guard.",
        structured: {
          steps: ["Guard settings access with optional chaining + default", "Add regression test for missing settings"],
          filesTouched: ["src/parseConfig.ts"],
          risk: "low",
        },
      }),
      tools: [{ name: "Read", input: { file_path: "src/parseConfig.ts" } }],
    },
  ]);

  const codexSession = new DemoSession("codex", runDir, [
    // independentAssessment
    {
      text: JSON.stringify({
        approach: "Add an optional-chaining guard with a default theme value.",
        risks: ["A silently-defaulted theme could mask a genuinely malformed config elsewhere"],
      }),
      command: "rg -n 'parseConfig' src",
    },
    // critiqueObjections round 1 -- no objections, converges immediately
    { text: JSON.stringify({ objections: [] }), command: "pnpm test" },
  ]);

  console.log(`[seed-demo] running Gate 1 pipeline for ${RUN_ID_COMPLETED} ...`);
  const planResult = await runPlanPipeline({
    repoRoot: DEMO_REPO_ROOT,
    worktreesRoot: WORKTREES_DIR,
    runsRoot: RUNS_DIR,
    description: "parseConfig() throws a TypeError when the config payload has no `settings` key",
    runId: RUN_ID_COMPLETED,
    claudeSession,
    codexSession,
  });
  console.log(`[seed-demo] ${RUN_ID_COMPLETED} parked at Gate 1 (checkpoint ${planResult.checkpointId}) -- approving it for real ...`);

  // Approve Gate 1 for real -- exactly what `pros answer <questionId> approve
  // --effect=continue_within_approved_plan` does (packages/cli/src/answer.ts):
  // a single Barrier.recordAnswer call, no claim/resume (that's a separate,
  // in-band-attempt concern this demo doesn't need).
  const barrier = await Barrier.open(runDir, RUN_ID_COMPLETED);
  try {
    const cp = barrier.getState().checkpoints.get(planResult.checkpointId);
    if (!cp) throw new Error(`seed-demo: checkpoint ${planResult.checkpointId} vanished right after parkForGate1`);
    await barrier.recordAnswer(planResult.checkpointId, planResult.questionId, cp.idempotencyKey, "approve", "continue_within_approved_plan");
  } finally {
    await barrier.close();
  }

  console.log(`[seed-demo] Gate 1 approved for ${RUN_ID_COMPLETED} -- running Gate 2 pipeline ...`);

  // Derive Gate 2 options from the run exactly the way `pros implement
  // <run-id>` does (packages/cli/src/implement.ts -> deriveGate2OptionsFromRun)
  // -- real worktreePath/branch/baseBranch/planMarkdown/fileAllowlist read
  // straight off the journal + plan.md, not re-derived by hand here.
  const derived = await deriveGate2OptionsFromRun({
    runsRoot: RUNS_DIR,
    runId: RUN_ID_COMPLETED,
    repoRoot: PROSHARNESS_ROOT,
  });

  const ghCredential: ScopedGhCredential = {
    token: "demo-stub-token",
    scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
    repo: "demo/pros-demo-repo",
  };
  const ghClient = new LocalGhStub({ bareRepoPath: DEMO_REPO_ORIGIN });

  const gate2Result = await runGate2Pipeline({
    ...derived,
    claudeSession: new ImplementSession(runDir, derived.worktreePath, [
      { severity: "minor", claim: "The default theme value (\"light\") is a magic string duplicated nowhere else -- consider a shared constant.", suggested_change: "Extract a DEFAULT_THEME constant." },
    ]),
    codexSession: new CodexReviewSession(runDir, []),
    verifierSession: new VerifierSession(runDir, { outcome: "pass", summary: "pnpm -r typecheck and pnpm -r test both pass", failingChecks: [] }),
    ghClient,
    ghCredential,
  });

  if (!gate2Result.pr) {
    throw new Error(`seed-demo: expected Gate 2 to open a draft PR for ${RUN_ID_COMPLETED}, but it aborted at "${gate2Result.aborted?.stage}": ${gate2Result.aborted?.reason}`);
  }

  console.log(`[seed-demo] ${RUN_ID_COMPLETED} completed Gate 2 -- draft PR #${gate2Result.pr.number} at ${gate2Result.pr.url}`);
  return { runId: RUN_ID_COMPLETED, prUrl: gate2Result.pr.url, prNumber: gate2Result.pr.number };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
  await mkdir(WORKTREES_DIR, { recursive: true });

  await ensureDemoRepo();

  const run1 = await seedParkedRun();
  const run2 = await seedCompletedRun();

  console.log(`[seed-demo] rebuilding index at ${INDEX_DB} ...`);
  const report = await rebuildIndex(INDEX_DB, RUNS_DIR);
  console.log(`[seed-demo] index rebuilt: ${report.runsProcessed} run(s) processed, ${report.eventsInserted} event(s), ${report.rawEventsInserted} raw event(s).`);

  console.log("");
  console.log("=================================================================");
  console.log(" Demo data seeded");
  console.log("=================================================================");
  console.log(`Runs dir:      ${RUNS_DIR}`);
  console.log(`Worktrees dir: ${WORKTREES_DIR}`);
  console.log(`Index db:      ${INDEX_DB}`);
  console.log(`Demo repo:     ${DEMO_REPO_ROOT} (origin: ${DEMO_REPO_ORIGIN})`);
  console.log("");

  if ("existing" in run1) {
    console.log(`Run "${run1.runId}": already existed, left untouched.`);
  } else {
    console.log(`Run "${run1.runId}": PARKED at Gate 1 (plan approval) -- pending human decision.`);
    console.log(`  To approve it:`);
    console.log(`    pros answer ${run1.questionId} approve --effect=continue_within_approved_plan`);
    console.log(`  (then run \`pros implement ${run1.runId}\` to drive it through Gate 2 immediately)`);
  }
  console.log("");

  if ("existing" in run2) {
    console.log(`Run "${run2.runId}": already existed, left untouched.`);
  } else {
    console.log(`Run "${run2.runId}": COMPLETED through Gate 2 -- draft PR #${run2.prNumber} at ${run2.prUrl}`);
    console.log(`  (local-only stub PR -- never touched real GitHub)`);
  }

  console.log("");
  console.log("Dashboard pages to check (pnpm --filter @pros/dashboard dev, then http://localhost:3000):");
  console.log("  /runs                -- both demo runs listed");
  console.log(`  /runs/${RUN_ID_PARKED}/plan       -- plan + Codex objections (1 accepted, 1 accepted-as-risk)`);
  console.log("  /questions           -- the parked Gate 1 decision for demo-parked-gate1");
  console.log(`  /runs/${RUN_ID_COMPLETED}/review     -- risk-ranked hunks, focus checklist, the draft PR`);
  console.log(`  /runs/${RUN_ID_PARKED}/graph      and  /runs/${RUN_ID_COMPLETED}/graph  -- session graphs`);
  console.log("=================================================================");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
