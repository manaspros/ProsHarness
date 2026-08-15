/**
 * implement.ts -- the scoped-fixer implementation stage (M4 Gate 2 pipeline).
 *
 * Runs the approved Gate-1 plan through a `ModelSession` (in the real
 * pipeline: a `RealClaudeSession`, driving Sonnet -- see
 * `.claude/agents/scoped-fixer.md`) inside an already-allocated worktree,
 * then verifies mechanically (via git, never by trusting the model's own
 * self-report) whether a commit actually landed and which files it touched.
 *
 * Per the project-wide `ModelSession` convention (packages/plan/src/model-session.ts),
 * this module never constructs `spawnClaude`/`spawnCodex` itself -- it only
 * ever talks to the `ModelSession` it's given, so tests can inject a fake.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelSession, ModelUsage } from "@pros/plan";
import { loadAgentBriefByName } from "@pros/agents";
import type { TokenCeiling } from "@pros/lease";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const SUMMARY_MAX_LEN = 2000;

export interface ImplementInput {
  /** Caller passes a real RealClaudeSession() for real runs, a fake for tests. */
  claudeSession: ModelSession;
  worktreePath: string;
  branch: string;
  /** The approved Gate-1 plan text. */
  planMarkdown: string;
  /** Globs/paths; folded into the prompt. The scoped-fixer brief enforces this itself -- we trust but also verify post-hoc (see AllocationAllowlistViolation below). */
  fileAllowlist: string[];
  runId: string;
  attemptId: string;
  rawLogPath?: string;
  /** Where to resolve .claude/agents/scoped-fixer.md from (via loadAgentBriefByName). */
  repoRoot: string;
  /** Optional; if given, .record(result.usage) is called after the run -- let TokenCeilingExceededError propagate, it's the caller's job to treat it as "stop the pipeline". */
  tokenCeiling?: TokenCeiling;
}

export interface ImplementResult {
  /** True iff HEAD in worktreePath changed vs. the base sha recorded before the run. */
  committed: boolean;
  headSha: string;
  baseSha: string;
  /** The model's final text response, truncated -- NOT the full raw event stream. */
  summary: string;
  usage: ModelUsage;
  /** From `git diff --name-only <baseSha> HEAD` in worktreePath. */
  filesChanged: string[];
}

/**
 * Thrown when a committed change touches a file outside `fileAllowlist`. We
 * do NOT try to auto-revert the commit -- just fail loudly so the pipeline
 * stops before verification/review/PR ever sees it.
 */
export class AllowlistViolationError extends Error {
  constructor(
    public readonly offendingFiles: string[],
    public readonly allowlist: string[],
  ) {
    super(
      `runImplementation: committed change touched file(s) outside the allowlist: ${offendingFiles.join(", ")} ` +
        `(allowlist: ${allowlist.join(", ") || "<empty>"})`,
    );
    this.name = "AllowlistViolationError";
  }
}

/** Simple glob-to-regex: `**` -> any chars, `*` -> any chars except `/`, everything else regex-escaped. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      pattern += ".*";
      i++; // skip the second '*'
    } else if (c === "*") {
      pattern += "[^/]*";
    } else {
      pattern += c!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAllowlist(file: string, allowlist: string[]): boolean {
  return allowlist.some((glob) => globToRegExp(glob).test(file));
}

export async function runImplementation(input: ImplementInput): Promise<ImplementResult> {
  const baseSha = (await git(input.worktreePath, ["rev-parse", "HEAD"])).trim();

  const brief = await loadAgentBriefByName(input.repoRoot, "scoped-fixer");

  const prompt = [
    brief.systemPrompt,
    "",
    "--- Approved plan (Gate 1) ---",
    input.planMarkdown,
    "",
    `File allowlist for this run: ${input.fileAllowlist.length > 0 ? input.fileAllowlist.join(", ") : "<none specified>"}`,
    "",
    "When you are finished, commit your changes with a single git commit (or a small number of tightly related commits) before finishing. Leave the working tree clean.",
  ].join("\n");

  const result = await input.claudeSession.run({
    cwd: input.worktreePath,
    prompt,
    attemptId: input.attemptId,
    rawLogPath: input.rawLogPath,
  });

  if (input.tokenCeiling) {
    input.tokenCeiling.record(result.usage);
  }

  const headSha = (await git(input.worktreePath, ["rev-parse", "HEAD"])).trim();
  const committed = headSha !== baseSha;

  let filesChanged: string[] = [];
  if (committed) {
    const out = await git(input.worktreePath, ["diff", "--name-only", baseSha, "HEAD"]);
    filesChanged = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

    if (input.fileAllowlist.length > 0) {
      const offending = filesChanged.filter((f) => !matchesAllowlist(f, input.fileAllowlist));
      if (offending.length > 0) {
        throw new AllowlistViolationError(offending, input.fileAllowlist);
      }
    }
  }

  return {
    committed,
    headSha,
    baseSha,
    summary: result.text.slice(0, SUMMARY_MAX_LEN),
    usage: result.usage,
    filesChanged,
  };
}
