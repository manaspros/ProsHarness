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

import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_SESSION_DIRECTIVE, type ModelSession, type ModelUsage } from "@pros/plan";
import { loadAgentBrief, loadAgentBriefByName } from "@pros/agents";
import type { TokenCeiling } from "@pros/lease";
import { git, checkGitCommitPreflight } from "@pros/barrier";
import { resolveProjectByRepoRoot, type ValidationCommand } from "./project-config.js";

const SUMMARY_MAX_LEN = 2000;

/**
 * Always granted, regardless of project: the exact mechanics the scoped-fixer
 * brief asks every implementer to perform (inspect the tree, stage, commit).
 * Deliberately NOT `Bash(git *)` -- that would also cover `git push` (the
 * deterministic orchestrator opens the PR, never the model session; see
 * pr.ts) and anything else under `git`, including a path to credential
 * material. Each entry is scoped to one subcommand with a trailing-`*`
 * prefix match, matching the CLI's documented `Bash(git log *)` pattern
 * syntax (confirmed against the CLI's own examples -- see claude.ts).
 */
const GIT_ALLOWED_TOOLS: string[] = ["Bash(git add *)", "Bash(git commit *)", "Bash(git diff *)", "Bash(git status *)"];

/**
 * Used only when `resolveProjectByRepoRoot` finds no registered project for
 * this run's originating repo (an unregistered/ad-hoc target, or a test).
 * A run that cannot run its own validation commands is useless, so this is
 * a real, working fallback -- ProsHarness's own two Quick Commands (see
 * this repo's CLAUDE.md) -- not an empty placeholder. Every use of it is
 * logged (see the `console.warn` in `runImplementation` below) specifically
 * so a silent fallback never masquerades as "the right project's commands
 * ran."
 */
const FALLBACK_VALIDATION_COMMANDS: ValidationCommand[] = [
  { command: "pnpm run typecheck", label: "typecheck (fallback: no project resolved)" },
  { command: "pnpm run test", label: "test (fallback: no project resolved)" },
];

/** `Bash(<command> *)` per project command, appended to the always-on git tools. */
function buildAllowedTools(validationCommands: ValidationCommand[]): string[] {
  return [...GIT_ALLOWED_TOOLS, ...validationCommands.map((vc) => `Bash(${vc.command} *)`)];
}

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
  /** Where to resolve .claude/agents/scoped-fixer.md from (via loadAgentBriefByName), unless `agentBriefPath` overrides it. */
  repoRoot: string;
  /**
   * Named-project generalization of the brief-loading seam: when set,
   * loaded directly (absolute, or resolved relative to `repoRoot`) instead
   * of the default `<repoRoot>/.claude/agents/scoped-fixer.md` convention.
   * Omitted means "use today's default" -- unchanged behavior for a project
   * that declares no override.
   */
  agentBriefPath?: string;
  /** Optional; if given, .record(result.usage) is called after the run -- let TokenCeilingExceededError propagate, it's the caller's job to treat it as "stop the pipeline". */
  tokenCeiling?: TokenCeiling;
  /**
   * Deprecated / ignored. The implement stage now always requests a scoped
   * `acceptEdits` + `--allowedTools` grant (see `runImplementation` below)
   * rather than a caller-supplied bypass -- `--dangerously-skip-permissions`
   * is never emitted from this stage, full stop. Field kept only so
   * existing callers (e.g. `pipeline.ts`) that still set it continue to
   * type-check; setting it to `true` no longer does anything here.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * The actual target repo's root (e.g. `Gate2PipelineOptions.worktreeParentRepo`
   * -- the repo `git worktree add` branched `worktreePath` from), used to
   * resolve this run's `ProjectConfig` for its `validationCommands`. This is
   * DIFFERENT from `repoRoot` above, which is ProsHarness's own installation
   * root (used only for brief loading) and will almost never match an entry
   * in `PROJECT_REGISTRY`. Omitted falls back to `repoRoot` for the lookup
   * (rarely a hit) and then to `FALLBACK_VALIDATION_COMMANDS` if that also
   * misses -- see the logged warning in `runImplementation`.
   */
  projectRepoRoot?: string;
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

/**
 * Thrown before the model session is even started, when `git commit` in
 * `worktreePath` would block on interactive signing. Failing fast here
 * beats letting the scoped-fixer's own `git commit` hang forever inside a
 * live model process the barrier has no way to distinguish from a slow but
 * healthy run -- see checkGitCommitPreflight in @pros/barrier for detail.
 */
export class GitSigningBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly remedy: string,
  ) {
    super(`runImplementation: git commit would block on interactive signing: ${reason}. ${remedy}`);
    this.name = "GitSigningBlockedError";
  }
}

export async function runImplementation(input: ImplementInput): Promise<ImplementResult> {
  const preflight = await checkGitCommitPreflight(input.worktreePath);
  if (preflight.blocked) {
    throw new GitSigningBlockedError(preflight.reason ?? "unknown", preflight.remedy ?? "disable commit.gpgsign for this repo");
  }

  assertImplementationScope(input.fileAllowlist);
  const before = await gitSnapshot(input.worktreePath);
  const preRunWorkingTreeFiles = [...before.status.keys()].sort();
  if (preRunWorkingTreeFiles.length > 0) {
    throw new UnexpectedWorkingTreeChangeError(preRunWorkingTreeFiles, "before");
  }
  const baseSha = before.headSha;

  const brief = input.agentBriefPath
    ? await loadAgentBrief(path.resolve(input.repoRoot, input.agentBriefPath))
    : await loadAgentBriefByName(input.repoRoot, "scoped-fixer");

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

  const projectLookupRoot = input.projectRepoRoot ?? input.repoRoot;
  const project = resolveProjectByRepoRoot(projectLookupRoot);
  let validationCommands: ValidationCommand[];
  if (project) {
    validationCommands = project.validationCommands;
  } else {
    validationCommands = FALLBACK_VALIDATION_COMMANDS;
    // Never silent: a run that fell through to a hardcoded validation-command
    // guess is a fact worth surfacing, not something to discover later by
    // noticing the wrong commands were allowlisted.
    console.warn(
      `runImplementation: no ProjectConfig resolved for repo root ${JSON.stringify(projectLookupRoot)} -- ` +
        `falling back to ProsHarness's own validation commands for --allowedTools ` +
        `(${FALLBACK_VALIDATION_COMMANDS.map((vc) => vc.command).join(", ")}). ` +
        `Add an entry to PROJECT_REGISTRY (packages/implement/src/project-config.ts) to grant this project's real commands.`,
    );
  }
  const allowedTools = buildAllowedTools(validationCommands);

  const result = await input.claudeSession.run({
    cwd: input.worktreePath,
    prompt,
    attemptId: input.attemptId,
    rawLogPath: input.rawLogPath,
    // Never `dangerouslySkipPermissions` here (see the field's doc comment
    // on ImplementInput) -- a headless implement run gets exactly this
    // scoped grant instead: `acceptEdits` (auto-approves edits inside
    // `worktreePath`, which the existing worktree allocation already bounds
    // -- see packages/worktree/src/allocator.ts) plus an explicit allowlist
    // of git plumbing + this project's own validation commands. No
    // `Bash(git push *)` is ever included: the deterministic orchestrator
    // opens the PR, never the model session (see pr.ts).
    permissionMode: "acceptEdits",
    allowedTools,
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
