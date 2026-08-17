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
import { createHash } from "node:crypto";
import { DEFAULT_SESSION_DIRECTIVE, type ModelSession, type ModelUsage } from "@pros/plan";
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
  /** Non-empty repository-relative paths/globs; folded into the prompt and verified post-hoc. */
  fileAllowlist: string[];
  runId: string;
  attemptId: string;
  rawLogPath?: string;
  /** Where to resolve .claude/agents/scoped-fixer.md from (via loadAgentBriefByName). */
  repoRoot: string;
  /** Optional; if given, .record(result.usage) is called after the run -- let TokenCeilingExceededError propagate, it's the caller's job to treat it as "stop the pipeline". */
  tokenCeiling?: TokenCeiling;
  /** Explicitly carry the Gate 1 permission policy into the fresh implementer context. */
  dangerouslySkipPermissions?: boolean;
}

export interface ImplementResult {
  /** True iff HEAD in worktreePath changed vs. the base sha recorded before the run. */
  committed: boolean;
  headSha: string;
  baseSha: string;
  /** The model's final text response, truncated -- NOT the full raw event stream. */
  summary: string;
  usage: ModelUsage;
  /** Committed files plus any newly changed working-tree files observed after the model run. */
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

/** Thrown when the model leaves a new staged, unstaged, or untracked change behind. */
export class UnexpectedWorkingTreeChangeError extends Error {
  constructor(
    public readonly offendingFiles: string[],
    phase: "before" | "after" = "after",
  ) {
    super(
      phase === "before"
        ? `runImplementation: worktree was already dirty before the model run: ${offendingFiles.join(", ")}`
        : `runImplementation: model left unexpected working-tree change(s) before verification: ${offendingFiles.join(", ")}`,
    );
    this.name = "UnexpectedWorkingTreeChangeError";
  }
}

/** Thrown when a caller tries to run a scoped implementation without a usable scope. */
export class InvalidFileAllowlistError extends Error {
  constructor(public readonly allowlist: unknown, reason: string) {
    super(`runImplementation: invalid file allowlist (${reason}); refusing to run implementation`);
    this.name = "InvalidFileAllowlistError";
  }
}

interface GitSnapshot {
  headSha: string;
  /** A content-sensitive representation of all tracked staged + unstaged changes. */
  trackedDiffHash: string;
  /** Porcelain status entries, including staged, unstaged, deleted, and untracked files. */
  status: Map<string, string>;
  /** Content-sensitive representation of standard (non-ignored) untracked files. */
  untrackedFiles: Map<string, string>;
}

function splitNulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  const headSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const trackedDiff = await git(cwd, ["diff", "--binary", "--no-renames", "HEAD", "--"]);
  const status = new Map<string, string>();
  for (const entry of splitNulList(await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]))) {
    // Porcelain v1 records are "XY path" followed by NUL. Keeping XY as
    // part of the snapshot catches a file changing from staged to unstaged
    // even when the path itself stays the same.
    if (entry.length < 4) continue;
    status.set(entry.slice(3), entry.slice(0, 2));
  }
  const untrackedPaths = splitNulList(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const untrackedFiles = new Map<string, string>();
  for (const file of untrackedPaths) {
    const hash = (await git(cwd, ["hash-object", "--no-filters", "--", file])).trim();
    untrackedFiles.set(file, hash);
  }

  return {
    headSha,
    trackedDiffHash: createHash("sha256").update(trackedDiff).digest("hex"),
    status,
    untrackedFiles,
  };
}

function snapshotDeltaFiles(before: GitSnapshot, after: GitSnapshot): string[] {
  const changed = new Set<string>();

  if (before.trackedDiffHash !== after.trackedDiffHash || before.status.size !== after.status.size) {
    for (const file of before.status.keys()) changed.add(file);
    for (const file of after.status.keys()) changed.add(file);
  } else {
    const statusPaths = new Set([...before.status.keys(), ...after.status.keys()]);
    for (const file of statusPaths) {
      if (before.status.get(file) !== after.status.get(file)) changed.add(file);
    }
  }

  const untrackedPaths = new Set([...before.untrackedFiles.keys(), ...after.untrackedFiles.keys()]);
  for (const file of untrackedPaths) {
    if (before.untrackedFiles.get(file) !== after.untrackedFiles.get(file)) changed.add(file);
  }

  return [...changed].sort();
}

function validateFileAllowlistShape(fileAllowlist: unknown): asserts fileAllowlist is string[] {
  if (!Array.isArray(fileAllowlist)) {
    throw new InvalidFileAllowlistError(fileAllowlist, "expected a string array");
  }
  const hasInvalidEntry = fileAllowlist.some(
    (entry) =>
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry !== entry.trim() ||
      entry.includes("\0") ||
      entry.startsWith("/") ||
      entry.split("/").some((segment) => segment === ".."),
  );
  if (hasInvalidEntry) {
    throw new InvalidFileAllowlistError(fileAllowlist, "entries must be clean repository-relative paths or globs");
  }
}

/** Gate 2's persisted implementation scope must be non-empty. */
export function assertImplementationScope(fileAllowlist: unknown): asserts fileAllowlist is string[] {
  validateFileAllowlistShape(fileAllowlist);
  if (fileAllowlist.length === 0) {
    throw new InvalidFileAllowlistError(fileAllowlist, "the implementation scope is empty");
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
  assertImplementationScope(input.fileAllowlist);
  const before = await gitSnapshot(input.worktreePath);
  const preRunWorkingTreeFiles = [...before.status.keys()].sort();
  if (preRunWorkingTreeFiles.length > 0) {
    throw new UnexpectedWorkingTreeChangeError(preRunWorkingTreeFiles, "before");
  }
  const baseSha = before.headSha;

  const brief = await loadAgentBriefByName(input.repoRoot, "scoped-fixer");

  const prompt = [
    brief.systemPrompt,
    "",
    DEFAULT_SESSION_DIRECTIVE,
    "",
    "--- Approved plan (Gate 1) ---",
    input.planMarkdown,
    "",
    `File allowlist for this run: ${input.fileAllowlist.join(", ")}`,
    "",
    "When you are finished, commit your changes with a single git commit (or a small number of tightly related commits) before finishing. Leave the working tree clean.",
  ].join("\n");

  const result = await input.claudeSession.run({
    cwd: input.worktreePath,
    prompt,
    attemptId: input.attemptId,
    rawLogPath: input.rawLogPath,
    dangerouslySkipPermissions: input.dangerouslySkipPermissions,
  });

  if (input.tokenCeiling) {
    input.tokenCeiling.record(result.usage);
  }

  const after = await gitSnapshot(input.worktreePath);
  const headSha = after.headSha;
  const committed = headSha !== baseSha;

  const workingTreeDelta = snapshotDeltaFiles(before, after);
  let committedFiles: string[] = [];
  if (committed) {
    committedFiles = splitNulList(
      await git(input.worktreePath, ["diff", "--name-only", "-z", "--no-renames", baseSha, "HEAD", "--"]),
    );
  }

  const filesChanged = [...new Set([...committedFiles, ...workingTreeDelta])].sort();
  const offending = filesChanged.filter((file) => !matchesAllowlist(file, input.fileAllowlist));
  if (offending.length > 0) {
    throw new AllowlistViolationError(offending, input.fileAllowlist);
  }

  // A committed change is the only expected post-run side effect. A dirty
  // worktree after the model returns means it did not honor the commit/clean
  // contract, even if the path itself is in scope; stop before verification.
  const postRunWorkingTreeFiles = [...after.status.keys()].sort();
  const postRunWorkingTreeSet = new Set(postRunWorkingTreeFiles);
  const changedWorkingTreeFiles = workingTreeDelta.filter((file) => postRunWorkingTreeSet.has(file));
  if (changedWorkingTreeFiles.length > 0) {
    throw new UnexpectedWorkingTreeChangeError(changedWorkingTreeFiles);
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
