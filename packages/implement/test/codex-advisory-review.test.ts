import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rankHunks, buildFocusChecklist, type RiskRankOptions } from "@pros/review";
import { runCodexAdvisoryReview, buildCodexAdvisoryPrompt } from "../src/review.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A real, small repo with a genuine bug in the diff -- same shape used for the manual real-`codex exec` proof for this phase. */
async function makeBuggyRepo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-codex-advisory-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const baseSha = (await git(dir, ["rev-parse", "HEAD"])).trim();

  await writeFile(
    path.join(dir, "add.ts"),
    "export function add(a: number, b: number): number {\n  // BUG: should be a + b\n  return a - b;\n}\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "flip add to subtract"], { cwd: dir });
  const headSha = (await git(dir, ["rev-parse", "HEAD"])).trim();

  return { dir, baseSha, headSha };
}

// ---------------------------------------------------------------------------
// Branch targeting: a checkout that moved must be refused, not silently
// reviewed. Mined rule: a past PR reviewed the wrong branch this way.
// ---------------------------------------------------------------------------

test("runCodexAdvisoryReview: refuses to review when worktree HEAD does not match the expected headSha (moved checkout)", async () => {
  const { dir, baseSha, headSha } = await makeBuggyRepo();
  try {
    const result = await runCodexAdvisoryReview({
      worktreePath: dir,
      branch: "feature/whatever",
      baseSha,
      headSha: "0000000000000000000000000000000000000000", // deliberately wrong
      planMarkdown: "# Plan",
      attemptId: "test-branch-mismatch",
    });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.findings, []);
    assert.ok(result.unavailableReason?.includes("moved"), `expected a moved-checkout explanation, got: ${result.unavailableReason}`);
    assert.ok(result.unavailableReason?.includes(headSha), "expected the actual (real) worktree HEAD sha to be reported for diagnosis");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Self-assessment exclusion: buildCodexAdvisoryPrompt's signature has no
// field for an implementer summary at all -- prove the actual prompt text
// only ever contains the plan + hunks + checklist, nothing else.
// ---------------------------------------------------------------------------

test("buildCodexAdvisoryPrompt: only contains the plan markdown, hunk text, and checklist -- never an implementer self-assessment", async () => {
  const { dir, baseSha, headSha } = await makeBuggyRepo();
  try {
    const rankOpts: RiskRankOptions = { repoRoot: dir, baseSha, headSha };
    const diff = rankHunks(rankOpts);
    const checklist = buildFocusChecklist(diff, rankOpts);
    const planMarkdown = "# Plan\nFix the add() bug.";

    const prompt = buildCodexAdvisoryPrompt(planMarkdown, diff, checklist);

    assert.ok(prompt.includes("Fix the add() bug."), "expected the plan markdown to be present");
    assert.ok(prompt.includes("return a - b"), "expected the actual hunk content to be present");
    // The exact marker a self-assessment field would carry if it leaked in --
    // `buildCodexAdvisoryPrompt`'s signature has no parameter that could ever
    // supply this text, so this also documents (not just asserts) the
    // structural guarantee.
    const selfAssessmentMarker = "I believe this change is correct and complete";
    assert.ok(!prompt.includes(selfAssessmentMarker), "self-assessment text must never appear in the advisory prompt");
    assert.ok(!prompt.toLowerCase().includes("self-assessment"), "the prompt must not even reference a self-assessment concept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Graceful degradation: absence must never render as approval.
// ---------------------------------------------------------------------------

test("runCodexAdvisoryReview: times out gracefully instead of hanging the pipeline, and absence is distinguishable from approval", async () => {
  const { dir, baseSha, headSha } = await makeBuggyRepo();
  try {
    // A nonexistent binary name substituted in for `codex` would require
    // touching module internals we don't inject in this phase; instead we
    // exercise the real timeout path with an intentionally tiny timeoutMs
    // against the real `codex` binary (if present) or let spawn ENOENT
    // surface as "unavailable" either way -- both are graceful-degradation
    // outcomes, never a thrown exception and never status "reviewed_no_blocker".
    const result = await runCodexAdvisoryReview({
      worktreePath: dir,
      branch: "feature/whatever",
      baseSha,
      headSha,
      planMarkdown: "# Plan",
      attemptId: "test-timeout",
      timeoutMs: 1, // effectively immediate
    });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.findings, []);
    assert.ok(result.unavailableReason && result.unavailableReason.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Headline proof: a real `codex exec` on a known-bad diff returns a
// schema-valid, non-empty verdict. Self-skips (does not fail) if the real
// `codex` CLI isn't available/authenticated in this environment or is
// unreasonably slow -- per this project's acceptance-test philosophy, a
// live-model timeout/absence is reported via skip, not a hard failure.
// ---------------------------------------------------------------------------

test("REAL CODEX ACCEPTANCE: a real codex exec --sandbox read-only run on a genuinely buggy diff returns schema-valid JSON", async (t) => {
  const hasCodexCli = await execFileAsync("which", ["codex"]).then(
    () => true,
    () => false,
  );
  if (!hasCodexCli) {
    t.skip("codex CLI not found on PATH");
    return;
  }

  const { dir, baseSha, headSha } = await makeBuggyRepo();
  try {
    const result = await runCodexAdvisoryReview({
      worktreePath: dir,
      branch: "feature/whatever",
      baseSha,
      headSha,
      planMarkdown: "# Plan\nRefactor add() to be more robust. Do not change its behavior.",
      attemptId: "test-real-codex-acceptance",
      timeoutMs: 120_000,
    });

    if (result.status === "unavailable") {
      t.skip(`real codex exec was unavailable in this environment: ${result.unavailableReason}`);
      return;
    }

    assert.ok(
      result.status === "reviewed_blocker" || result.status === "reviewed_no_blocker",
      `expected a real verdict, got status=${result.status}`,
    );
    assert.ok(Array.isArray(result.findings));
    // eslint-disable-next-line no-console
    console.log("REAL CODEX ADVISORY VERDICT:", JSON.stringify(result));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
