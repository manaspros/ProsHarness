/**
 * review.ts -- Codex adversarial review + claude ultrareview (M4 Gate 2).
 *
 * This is the automated, non-interactive counterpart of
 * `.claude/skills/review/SKILL.md` -- this module loads and embeds that
 * file's text into the prompts below rather than hand-duplicating the
 * procedure, so the interactive-skill path and the automated-pipeline path
 * stay in sync as that file changes.
 *
 * Gate 2 review runs ONCE, non-interactively; it does not debate to
 * convergence the way Gate 1's `runDebate` does. Any blocker it finds is,
 * by construction, unresolved (nothing in this one-shot pass ever sets
 * `resolution`), and `pipeline.ts` treats a non-empty `unresolvedBlockers`
 * as blocking draft-PR creation.
 *
 * ---- Phase 6: `runCodexAdvisoryReview` (bottom of this file) ----
 *
 * A SEPARATE, second Codex pass from the one above. `runAdversarialReview`'s
 * codex leg still gates the PR via `unresolvedBlockers` (unchanged --
 * out of this phase's scope to touch that contract). `runCodexAdvisoryReview`
 * is deliberately advisory-only and can never block anything:
 *   - it drives `codex exec` directly via `@pros/adapters` (not the
 *     `ModelSession`/`RealCodexSession` abstraction above), because it needs
 *     `--sandbox read-only` -- `RealCodexSession` always requests
 *     `--dangerously-bypass-approvals-and-sandbox` for its gating pass, and
 *     widening THIS reviewer past read-only would let it start fixing
 *     instead of judging, collapsing the finder/implementer/verifier split;
 *   - it is fed the risk-ranked hunks + approved plan (`@pros/review`), not
 *     the raw diff and NOT the implementer's own self-assessment
 *     (`ImplementResult.summary` never reaches this function -- the input
 *     type below has no field for it, structurally, not just by omission);
 *   - failure of any kind (timeout, non-zero exit, malformed JSON, a moved
 *     checkout) degrades to `{status: "unavailable", ...}`, never silently
 *     to "approved".
 *
 * No controlled study was found showing cross-model review catches more
 * than same-model review with a fresh context -- the case for running this
 * at all is ensemble diversity at near-zero marginal cost, not a proven
 * detection-rate improvement. Do not oversell this in UI copy either.
 */

import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DEFAULT_SESSION_DIRECTIVE, type ModelSession, type Objection, type Severity } from "@pros/plan";
import { loadSkillBrief } from "@pros/agents";
import type { TokenCeiling } from "@pros/lease";
import { runGit } from "@pros/barrier";
import { spawnCodex, buildCodexAdvisoryExtraArgs, collectCodexAdvisoryOutcome } from "@pros/adapters";
import { rankHunks, buildFocusChecklist, type RiskRankOptions } from "@pros/review";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// Same shape as packages/plan/src/critique.ts's OBJECTIONS_SCHEMA -- not
// exported from there, so redefined here field-for-field identically
// (severity/claim/suggested_change) rather than inventing a different
// objection shape.
const OBJECTIONS_SCHEMA = {
  type: "object",
  properties: {
    objections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          claim: { type: "string" },
          suggested_change: { type: "string" },
        },
        required: ["severity", "claim", "suggested_change"],
      },
    },
  },
  required: ["objections"],
} as const;

function parseObjections(text: string, label: string): Objection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: model output was not valid JSON: ${(err as Error).message}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.objections)) {
    throw new Error(`${label}: malformed response, expected {objections: [...]}`);
  }
  return (obj.objections as unknown[]).map((o, i) => {
    const rec = o as Record<string, unknown>;
    if (
      typeof rec.severity !== "string" ||
      !["blocker", "major", "minor"].includes(rec.severity) ||
      typeof rec.claim !== "string" ||
      typeof rec.suggested_change !== "string"
    ) {
      throw new Error(`${label}: malformed objection at index ${i}: ${JSON.stringify(o)}`);
    }
    return {
      severity: rec.severity as Severity,
      claim: rec.claim,
      suggested_change: rec.suggested_change,
      // Deliberately left unresolved: this is a one-shot automated pass with
      // no interactive debate loop (unlike Gate 1's runDebate), so every
      // objection here is unresolved by construction.
      resolution: undefined,
    };
  });
}

export interface ReviewInput {
  /** For the "claude ultrareview" pass -- MUST be a fresh session/attempt, not the implementer's. */
  claudeSession: ModelSession;
  /** For the Codex adversarial pass. */
  codexSession: ModelSession;
  worktreePath: string;
  /** To resolve .claude/skills/review/SKILL.md, unless `reviewSkillPath` overrides it. */
  repoRoot: string;
  /**
   * Named-project generalization of the brief-loading seam: when set, loaded
   * directly (absolute, or resolved relative to `repoRoot`) instead of the
   * default `<repoRoot>/.claude/skills/review/SKILL.md` convention. Omitted
   * means "use today's default" -- unchanged behavior for a project that
   * declares no override.
   */
  reviewSkillPath?: string;
  baseSha: string;
  headSha: string;
  planMarkdown: string;
  runId: string;
  /** Build e.g. `${attemptIdPrefix}-codex-review` / `${attemptIdPrefix}-ultrareview`. */
  attemptIdPrefix: string;
  rawLogPath?: string;
  rawLogPathForAttempt?: (attemptId: string) => string;
  tokenCeiling?: TokenCeiling;
  dangerouslySkipPermissions?: boolean;
}

export interface ReviewResult {
  /** Same shape as Gate 1 critique, per the skill file's explicit requirement. */
  objections: Objection[];
  verdict: "approve" | "blockers-present";
  unresolvedBlockers: Objection[];
}

export async function runAdversarialReview(input: ReviewInput): Promise<ReviewResult> {
  // Reviewers need the real diff -- not truncated, however large.
  const diff = await git(input.worktreePath, ["diff", input.baseSha, input.headSha]);

  const skill = await loadSkillBrief(
    input.reviewSkillPath
      ? path.resolve(input.repoRoot, input.reviewSkillPath)
      : path.join(input.repoRoot, ".claude", "skills", "review", "SKILL.md"),
  );

  const sharedContext = [
    skill.body,
    "",
    "--- Approved plan (Gate 1) ---",
    input.planMarkdown,
    "",
    "--- Diff under review ---",
    diff,
    "",
  ].join("\n");

  const codexPrompt = [
    sharedContext,
    "You are the Codex adversarial reviewer (step 1 of the procedure above). Find real, concrete problems in this",
    "diff: correctness bugs, missed edge cases, whether the diff actually satisfies the approved plan (not just",
    "whether it compiles), and security issues. Do not compliment the diff -- find objections.",
    "",
    'Conclude with a single JSON object (matching the provided schema): {"objections":[{"severity":"blocker|major|minor",',
    '"claim":"...","suggested_change":"..."}]}. If you have no objections, return an empty array.',
  ].join("\n");

  const claudePrompt = [
    sharedContext,
    DEFAULT_SESSION_DIRECTIVE,
    "",
    "You are the fresh `claude ultrareview` self-review pass (step 2 of the procedure above) -- a fresh context,",
    "not the session that wrote this diff. Hunt specifically for what an adversarial reviewer would flag that the",
    "implementer, reasoning about its own work, would be structurally prone to miss: silent scope creep beyond the",
    "approved plan, an untested edge case, or a change that 'looks done' but leaves the repo in a broken state",
    "(uncommitted files, a failing test the diff doesn't fix, a partial refactor).",
    "",
    'Conclude with a single JSON object (matching the provided schema): {"objections":[{"severity":"blocker|major|minor",',
    '"claim":"...","suggested_change":"..."}]}. If you have no objections, return an empty array.',
  ].join("\n");
  const codexAttemptId = `${input.attemptIdPrefix}-codex-review`;
  const claudeAttemptId = `${input.attemptIdPrefix}-ultrareview`;
  const rawLogPath = (attemptId: string): string | undefined => input.rawLogPathForAttempt?.(attemptId) ?? input.rawLogPath;

  const [codexResult, claudeResult] = await Promise.all([
    input.codexSession.run({
      cwd: input.worktreePath,
      prompt: codexPrompt,
      schema: OBJECTIONS_SCHEMA,
      attemptId: codexAttemptId,
      rawLogPath: rawLogPath(codexAttemptId),
      dangerouslySkipPermissions: input.dangerouslySkipPermissions,
    }),
    input.claudeSession.run({
      cwd: input.worktreePath,
      prompt: claudePrompt,
      schema: OBJECTIONS_SCHEMA,
      attemptId: claudeAttemptId,
      rawLogPath: rawLogPath(claudeAttemptId),
      dangerouslySkipPermissions: input.dangerouslySkipPermissions,
    }),
  ]);

  if (input.tokenCeiling) {
    input.tokenCeiling.record(codexResult.usage);
    input.tokenCeiling.record(claudeResult.usage);
  }

  const codexObjections = parseObjections(codexResult.text, "runAdversarialReview (codex)");
  const claudeObjections = parseObjections(claudeResult.text, "runAdversarialReview (claude ultrareview)");

  // Plain concatenation -- no deduping beyond this. A future pass could
  // dedupe near-identical claims between the two passes, but that's out of
  // scope here.
  const objections = [...codexObjections, ...claudeObjections];

  const unresolvedBlockers = objections.filter((o) => o.severity === "blocker" && o.resolution !== "accepted");
  const verdict: "approve" | "blockers-present" = unresolvedBlockers.length === 0 ? "approve" : "blockers-present";

  return { objections, verdict, unresolvedBlockers };
}

// ---------------------------------------------------------------------------
// Codex advisory review (Phase 6) -- see this file's top doc comment.
// ---------------------------------------------------------------------------

export type CodexAdvisoryStatus = "reviewed_no_blocker" | "reviewed_blocker" | "unavailable";

/** No confidence/score field by design -- the dashboard's confidence model represents this as one binary advisory fact ("independently reviewed, no blocker"), never a percentage. */
export interface CodexAdvisoryFinding {
  severity: "blocker" | "note";
  claim: string;
}

export interface CodexAdvisoryResult {
  status: CodexAdvisoryStatus;
  /** Always [] when status === "unavailable" -- absence of a verdict, not an empty-but-clean one. */
  findings: CodexAdvisoryFinding[];
  /** Set only when status === "unavailable"; an honest, actionable reason (never silently swallowed). */
  unavailableReason?: string;
}

/**
 * Deliberately NOT `ImplementResult` or anything carrying `summary` --
 * structurally prevents the implementer's self-assessment from ever
 * reaching this function's prompt (see test coverage in review.test.ts).
 */
export interface CodexAdvisoryReviewInput {
  worktreePath: string;
  /** The branch this review is supposed to be judging -- included for the mismatch error message, not passed to codex directly (codex reviews whatever `worktreePath` has checked out). */
  branch: string;
  baseSha: string;
  headSha: string;
  planMarkdown: string;
  attemptId: string;
  rawLogPath?: string;
  /** Defaults to 5 minutes. A hung `codex exec` must not hang the pipeline. */
  timeoutMs?: number;
}

const CODEX_ADVISORY_SCHEMA = {
  type: "object",
  properties: {
    raised_blocker: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "note"] },
          claim: { type: "string" },
        },
        required: ["severity", "claim"],
        additionalProperties: false,
      },
    },
  },
  required: ["raised_blocker", "findings"],
  additionalProperties: false,
} as const;

const DEFAULT_ADVISORY_TIMEOUT_MS = 5 * 60 * 1000;

function formatHunksForPrompt(diff: ReturnType<typeof rankHunks>): string {
  const visible = diff.hunks.filter((h) => !h.collapsedByDefault);
  if (visible.length === 0) return "(no non-trivial hunks -- everything collapsed as lockfile/generated/whitespace-only)";
  return visible
    .map((h) => `--- ${h.file}:${h.startLine} (risk ${h.riskScore}: ${h.riskFactors.join(", ") || "none"}) ---\n${h.patchText}`)
    .join("\n\n");
}

function formatChecklistForPrompt(items: ReturnType<typeof buildFocusChecklist>): string {
  if (items.length === 0) return "(none flagged)";
  return items.map((c) => `[${c.category}] ${c.file}${c.line !== undefined ? `:${c.line}` : ""} -- ${c.description}`).join("\n");
}

/**
 * Pure prompt builder, deliberately taking ONLY `planMarkdown` + the
 * deterministic hunks/checklist from `@pros/review` as parameters --
 * structurally, there is no way to pass an `ImplementResult`/self-assessment
 * summary into this function, so it cannot leak into the prompt by accident.
 * Exported for direct testing (see review.test.ts's self-assessment-exclusion
 * coverage) rather than only exercised indirectly through a real/stubbed
 * `codex exec` call.
 */
export function buildCodexAdvisoryPrompt(planMarkdown: string, diff: ReturnType<typeof rankHunks>, checklist: ReturnType<typeof buildFocusChecklist>): string {
  return [
    "You are an independent, read-only code reviewer running in a sandbox with no write access -- you cannot and must not attempt to edit files.",
    "You are given the human-approved plan and a risk-ranked summary of the diff's hunks -- not the implementer's own account of what it did.",
    "Your primary question: does this diff actually implement the approved plan below, or did scope move? Also flag any real, concrete correctness bug visible from the hunks alone.",
    "Do not compliment the diff. Only report genuine problems; an empty findings list is a valid, honest answer.",
    "",
    "--- Approved plan (Gate 1) ---",
    planMarkdown,
    "",
    "--- Risk-ranked hunks (highest risk first; low-signal hunks omitted) ---",
    formatHunksForPrompt(diff),
    "",
    "--- Deterministic focus checklist ---",
    formatChecklistForPrompt(checklist),
    "",
    'Respond with a single JSON object matching the schema: {"raised_blocker": boolean, "findings": [{"severity": "blocker"|"note", "claim": "..."}]}.',
  ].join("\n");
}

/**
 * Runs a read-only, structured, advisory-only Codex review of an
 * already-committed diff. Fed the risk-ranked hunks + focus checklist
 * (`@pros/review`) and the approved Gate 1 plan -- NOT the raw diff, and NOT
 * the implementer's own self-assessment. Never throws: every failure mode
 * (moved checkout, timeout, non-zero exit, malformed/absent JSON) resolves
 * to `{status: "unavailable", ...}` so a caller can record the verdict
 * honestly instead of treating absence as approval.
 */
export async function runCodexAdvisoryReview(input: CodexAdvisoryReviewInput): Promise<CodexAdvisoryResult> {
  // Mined rule: a past PR reviewed the wrong branch because the checkout had
  // moved between when the diff was computed and when review ran. Refuse
  // outright rather than silently reviewing whatever `worktreePath` now
  // happens to contain.
  const actualHead = (await git(input.worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== input.headSha) {
    return {
      status: "unavailable",
      findings: [],
      unavailableReason:
        `worktree HEAD is ${actualHead}, expected ${input.headSha} for branch ${JSON.stringify(input.branch)} -- ` +
        "refusing to review a checkout that moved out from under this review",
    };
  }

  const rankOpts: RiskRankOptions = { repoRoot: input.worktreePath, baseSha: input.baseSha, headSha: input.headSha };
  const diff = rankHunks(rankOpts);
  const checklist = buildFocusChecklist(diff, rankOpts);

  const prompt = buildCodexAdvisoryPrompt(input.planMarkdown, diff, checklist);

  let schemaTmpDir: string | undefined;
  try {
    schemaTmpDir = await mkdtemp(path.join(tmpdir(), "pros-codex-advisory-schema-"));
    const schemaPath = path.join(schemaTmpDir, "schema.json");
    await writeFile(schemaPath, JSON.stringify(CODEX_ADVISORY_SCHEMA));

    // No API key is ever set here -- codex relies on its own authenticated
    // CLI credential store (see @pros/adapters' spawn-common.ts, which
    // unconditionally strips OPENAI_API_KEY/CODEX_API_KEY for every codex
    // spawn, including this one). `dangerouslySkipPermissions` is
    // deliberately omitted/false: read-only sandbox mode needs no approval
    // bypass, and requesting one here would be the exact widening this
    // reviewer must not do.
    const { events, child, exitCode, stderr } = spawnCodex({
      cwd: input.worktreePath,
      prompt,
      extraArgs: buildCodexAdvisoryExtraArgs(schemaPath),
      attemptId: input.attemptId,
      rawLogPath: input.rawLogPath,
    });

    const timeoutMs = input.timeoutMs ?? DEFAULT_ADVISORY_TIMEOUT_MS;
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        resolve("timeout");
      }, timeoutMs);
      timer.unref();
    });

    const outcome = await Promise.race([collectCodexAdvisoryOutcome(events), timeout]);
    const [exitCodeValue, stderrText] = await Promise.all([exitCode, stderr]);

    if (outcome === "timeout" || timedOut) {
      return {
        status: "unavailable",
        findings: [],
        unavailableReason: `codex advisory review timed out after ${timeoutMs}ms and was killed`,
      };
    }

    if (outcome.status !== "ok") {
      return {
        status: "unavailable",
        findings: [],
        unavailableReason:
          `codex advisory review ${outcome.status} (exit ${exitCodeValue ?? "unknown"}): ${outcome.detail ?? ""}` +
          (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.text ?? "");
    } catch (err) {
      return {
        status: "unavailable",
        findings: [],
        unavailableReason: `codex advisory review returned non-JSON output: ${(err as Error).message}`,
      };
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj?.raised_blocker !== "boolean" || !Array.isArray(obj.findings)) {
      return {
        status: "unavailable",
        findings: [],
        unavailableReason: `codex advisory review returned malformed JSON (expected {raised_blocker, findings}): ${JSON.stringify(parsed)}`,
      };
    }

    const findings: CodexAdvisoryFinding[] = [];
    for (const f of obj.findings as unknown[]) {
      const rec = f as Record<string, unknown>;
      if (typeof rec.severity !== "string" || !["blocker", "note"].includes(rec.severity) || typeof rec.claim !== "string") {
        return {
          status: "unavailable",
          findings: [],
          unavailableReason: `codex advisory review returned a malformed finding: ${JSON.stringify(f)}`,
        };
      }
      findings.push({ severity: rec.severity as "blocker" | "note", claim: rec.claim });
    }

    return { status: obj.raised_blocker ? "reviewed_blocker" : "reviewed_no_blocker", findings };
  } finally {
    if (schemaTmpDir) await rm(schemaTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
