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
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ModelSession, Objection, Severity } from "@pros/plan";
import { loadSkillBrief } from "@pros/agents";
import type { TokenCeiling } from "@pros/lease";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
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
  /** To resolve .claude/skills/review/SKILL.md. */
  repoRoot: string;
  baseSha: string;
  headSha: string;
  planMarkdown: string;
  runId: string;
  /** Build e.g. `${attemptIdPrefix}-codex-review` / `${attemptIdPrefix}-ultrareview`. */
  attemptIdPrefix: string;
  rawLogPath?: string;
  tokenCeiling?: TokenCeiling;
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

  const skill = await loadSkillBrief(path.join(input.repoRoot, ".claude", "skills", "review", "SKILL.md"));

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
    "You are the fresh `claude ultrareview` self-review pass (step 2 of the procedure above) -- a fresh context,",
    "not the session that wrote this diff. Hunt specifically for what an adversarial reviewer would flag that the",
    "implementer, reasoning about its own work, would be structurally prone to miss: silent scope creep beyond the",
    "approved plan, an untested edge case, or a change that 'looks done' but leaves the repo in a broken state",
    "(uncommitted files, a failing test the diff doesn't fix, a partial refactor).",
    "",
    'Conclude with a single JSON object (matching the provided schema): {"objections":[{"severity":"blocker|major|minor",',
    '"claim":"...","suggested_change":"..."}]}. If you have no objections, return an empty array.',
  ].join("\n");

  const [codexResult, claudeResult] = await Promise.all([
    input.codexSession.run({
      cwd: input.worktreePath,
      prompt: codexPrompt,
      schema: OBJECTIONS_SCHEMA,
      attemptId: `${input.attemptIdPrefix}-codex-review`,
      rawLogPath: input.rawLogPath,
    }),
    input.claudeSession.run({
      cwd: input.worktreePath,
      prompt: claudePrompt,
      schema: OBJECTIONS_SCHEMA,
      attemptId: `${input.attemptIdPrefix}-ultrareview`,
      rawLogPath: input.rawLogPath,
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
