/**
 * project-config.ts -- static, human-edited named-project registry.
 *
 * There is no "project" concept upstream of this module: a run is only ever
 * `{repoRoot, description}` (see `packages/cli/src/plan.ts`). This module adds
 * a lookup layer on top of that, resolved at the CLI/dashboard boundary into
 * `PlanPipelineOptions` (`@pros/plan`) and `Gate2PipelineOptions` (this
 * package's `pipeline.ts`, the "ImplementPipelineOptions" of the design doc).
 *
 * Deliberately NOT durable state: the journal keeps recording `repoRoot`
 * exactly as it does today (see D-invariant "the journal is the source of
 * truth"). A `ProjectConfig` is config lookup only -- resolved fresh on every
 * CLI/dashboard call, never written to a journal event. If a future change
 * wants to persist project identity per-run, that is a journal schema change
 * and belongs to a different, explicitly-scoped phase.
 *
 * Lives in `@pros/implement` (not a new package, not `@pros/plan`) because:
 *   - both `@pros/cli` and `@pros/dashboard` already depend on it directly.
 *   - it needs to reference both `PlanPipelineOptions` (`@pros/plan`) and
 *     `Gate2PipelineOptions` (this package's own `pipeline.ts`) by type, and
 *     `@pros/implement` already depends on `@pros/plan` -- putting this in
 *     `@pros/plan` instead would require `@pros/plan` to depend back on
 *     `@pros/implement`, a cycle (implement -> plan already exists).
 *   - `@pros/agents` (the brief-loading package) can't hold this either: it
 *     is a dependency of `@pros/implement`, so the same cycle problem applies.
 *
 * Adding a future project (e.g. "Mothership") is exactly one more entry in
 * `PROJECT_REGISTRY` below -- no code path in this file, `plan.ts`, or the
 * pipelines needs to change for that.
 */

import path from "node:path";

/** A single shell command Phase 3 will spawn verbatim and record the outcome of. */
export interface ValidationCommand {
  /** Full shell command exactly as a human runs it, e.g. "just verify" or "pnpm test". */
  command: string;
  /** Optional human-facing label for dashboard display; defaults to `command` itself. */
  label?: string;
}

/**
 * Mined rule 2 ("never invent a branch name -- take Linear's `gitBranchName`
 * field"): a project's branch name must come from this source, not be
 * synthesized locally. Only one variant exists today because that is the
 * only mechanism actually observed; the Linear-fetching code itself lives in
 * `packages/triggers/src/sources/linear.ts` / `packages/dashboard/lib/linear.ts`
 * (both currently modified in the working tree by another change -- read
 * only, not edited here). Adding a second source later is one more union
 * member, not a redesign.
 */
export type BranchNameSource = "linear-git-branch-name";

export interface ProjectConfig {
  /** Human-facing identifier, e.g. "agent-gateway". Used for --project=<name> lookups. */
  name: string;
  /** Absolute path to the repo's working copy. */
  repoRoot: string;
  /** git remote URL (informational; not used for auth -- see pr.ts's credential boundary). */
  remote?: string;
  /** Linear team key/name findings for this project should be filed against. */
  linearTeam?: string;
  /**
   * Mined rule 1 ("never begin implementation without a ticket reference"):
   * machine-checkable by matching the finding/plan description against this
   * pattern. See `requireTicketReference` below for where it's enforced.
   */
  ticketPattern: RegExp;
  /** Mined rule 2, see `BranchNameSource` doc comment. */
  branchNameSource: BranchNameSource;
  /** Ordered; run in sequence by Phase 3. Empty array means "none observed" -- honest, not a placeholder. */
  validationCommands: ValidationCommand[];
  /**
   * Overrides for the existing brief-loading seam (generalized in
   * implement.ts/review.ts to accept these instead of only ever resolving
   * `.claude/agents/scoped-fixer.md` / `.claude/skills/review/SKILL.md`).
   * Absolute, or relative to `repoRoot`. Omitted means "use today's default
   * convention" -- unchanged behavior for a project that declares neither.
   */
  agentBriefPath?: string;
  reviewSkillPath?: string;
  /** Globs/paths threaded into `Gate2PipelineOptions.fileAllowlist` when the caller doesn't override it. */
  defaultFileAllowlist: string[];
  /**
   * Mined rule 3 ("no ticket IDs in PR titles/bodies/commit messages; PR
   * title form is `verb: object`"): machine-checkable shape for a future PR
   * title validator. Not wired into `pr.ts` in this phase (out of surface --
   * see FOLLOW-UPS) but the shape is here so that wiring is additive.
   */
  prTitlePattern?: RegExp;
  /**
   * Phase 6 opt-out: skip the advisory `runCodexAdvisoryReview` pass
   * entirely for this project. Omitted/false runs it (the default) --
   * it is advisory-only and never gates the PR, so there is normally no
   * reason to disable it; this exists for a project that, for whatever
   * reason, cannot spare a second `codex exec` invocation per run.
   */
  codexAdvisoryReviewDisabled?: boolean;
}

/** Thrown by `assertValidProjectConfig` -- a malformed registry entry is a programmer error, not a runtime one, so this fails loudly at load time. */
export class InvalidProjectConfigError extends Error {
  constructor(name: string, reason: string) {
    super(`invalid ProjectConfig for "${name}": ${reason}`);
    this.name = "InvalidProjectConfigError";
  }
}

/**
 * Hand-written structural validation -- no schema library. The repo has no
 * existing general-purpose validation dependency (zod is present only
 * transitively, via `@modelcontextprotocol/sdk` inside `@pros/mcp`, not as a
 * direct dependency anywhere else), and adding one for this alone would be a
 * new direct dependency for a five-entry static config. Per CLAUDE.md
 * dependency policy, hand-writing this check is the right call here.
 */
export function assertValidProjectConfig(config: ProjectConfig): void {
  if (!config.name || config.name.trim().length === 0) {
    throw new InvalidProjectConfigError(config.name || "<empty>", "name must be a non-empty string");
  }
  if (!config.repoRoot || !path.isAbsolute(config.repoRoot)) {
    throw new InvalidProjectConfigError(config.name, `repoRoot must be an absolute path, got: ${JSON.stringify(config.repoRoot)}`);
  }
  if (!(config.ticketPattern instanceof RegExp)) {
    throw new InvalidProjectConfigError(config.name, "ticketPattern must be a RegExp");
  }
  if (config.branchNameSource !== "linear-git-branch-name") {
    throw new InvalidProjectConfigError(config.name, `unknown branchNameSource: ${JSON.stringify(config.branchNameSource)}`);
  }
  if (!Array.isArray(config.validationCommands)) {
    throw new InvalidProjectConfigError(config.name, "validationCommands must be an array (use [] for none observed)");
  }
  for (const vc of config.validationCommands) {
    if (!vc.command || vc.command.trim().length === 0) {
      throw new InvalidProjectConfigError(config.name, "every validationCommands entry needs a non-empty command");
    }
  }
  if (!Array.isArray(config.defaultFileAllowlist)) {
    throw new InvalidProjectConfigError(config.name, "defaultFileAllowlist must be an array (use [] for none)");
  }
}

const AGENT_REGISTRY_ROOT = "/Users/manas.choudhary/Documents/Project/AgentRegistry";

/**
 * Seed data mined from 43 of the operator's real sessions across these five
 * repos. Ticket IDs are `AGENT-####` and the Linear team is `atlan-epd` for
 * all five -- these are one physical "Agent Registry" umbrella, not five
 * independent Linear teams.
 *
 * `infrastructure` intentionally has an empty `validationCommands`: no
 * validation command was ever observed in use there. Do not invent one.
 */
export const PROJECT_REGISTRY: ProjectConfig[] = [
  {
    name: "agent-gateway",
    repoRoot: path.join(AGENT_REGISTRY_ROOT, "agent-gateway"),
    remote: "https://github.com/atlanai/agent-gateway.git",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [{ command: "just verify" }, { command: "cargo test --locked" }],
    defaultFileAllowlist: [],
    prTitlePattern: /^[a-z]+: .+/,
  },
  {
    name: "control-plane",
    repoRoot: path.join(AGENT_REGISTRY_ROOT, "control-plane"),
    remote: "https://github.com/atlanai/control-plane.git",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [{ command: "make up" }, { command: "go test -race ./..." }],
    defaultFileAllowlist: [],
    prTitlePattern: /^[a-z]+: .+/,
  },
  {
    name: "frontend",
    repoRoot: path.join(AGENT_REGISTRY_ROOT, "frontend"),
    remote: "https://github.com/atlanai/frontend.git",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [
      { command: "pnpm typecheck" },
      { command: "pnpm test" },
      { command: "pnpm lint" },
      { command: "pnpm format:check" },
      { command: "pnpm check:secrets" },
    ],
    defaultFileAllowlist: [],
    prTitlePattern: /^[a-z]+: .+/,
  },
  {
    name: "atlan-plugins",
    repoRoot: path.join(AGENT_REGISTRY_ROOT, "atlan-plugins"),
    remote: "https://github.com/atlanai/atlan-plugins.git",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    validationCommands: [
      { command: "make build" },
      { command: "make test" },
      { command: "make fmt" },
      { command: "make vet" },
      { command: "make check" },
    ],
    defaultFileAllowlist: [],
    prTitlePattern: /^[a-z]+: .+/,
  },
  {
    name: "infrastructure",
    repoRoot: path.join(AGENT_REGISTRY_ROOT, "infrastructure"),
    remote: "https://github.com/atlanai/infrastructure.git",
    linearTeam: "atlan-epd",
    ticketPattern: /AGENT-\d+/,
    branchNameSource: "linear-git-branch-name",
    // No validation command observed for this project -- honest empty list, not invented.
    validationCommands: [],
    defaultFileAllowlist: [],
    prTitlePattern: /^[a-z]+: .+/,
  },
];

for (const project of PROJECT_REGISTRY) {
  assertValidProjectConfig(project);
}

/** Thrown when a caller asks for a project name or repoRoot that isn't in the registry -- the allowlist is a feature, so this must be loud and actionable. */
export class UnknownProjectError extends Error {
  constructor(lookup: string, registry: ProjectConfig[]) {
    super(
      `unknown project ${JSON.stringify(lookup)}. Known projects: ${registry.map((p) => p.name).join(", ") || "<none registered>"}. ` +
        `Add an entry to PROJECT_REGISTRY in packages/implement/src/project-config.ts, or pass a bare repoRoot instead of --project.`,
    );
    this.name = "UnknownProjectError";
  }
}

/** Looks up a project by its human name. Returns undefined (never throws) -- callers that need loud failure should use `requireProjectByName`. */
export function resolveProjectByName(name: string, registry: ProjectConfig[] = PROJECT_REGISTRY): ProjectConfig | undefined {
  return registry.find((p) => p.name === name);
}

/** Looks up a project by an exact, already-resolved absolute repoRoot. Returns undefined for any repo not in the registry -- this is intentionally NOT a fuzzy/prefix match. */
export function resolveProjectByRepoRoot(repoRoot: string, registry: ProjectConfig[] = PROJECT_REGISTRY): ProjectConfig | undefined {
  const resolved = path.resolve(repoRoot);
  return registry.find((p) => path.resolve(p.repoRoot) === resolved);
}

/** Same as `resolveProjectByName`, but throws `UnknownProjectError` (loud, actionable) instead of returning undefined. Use this at the CLI/dashboard boundary when the caller explicitly opted into named-project mode. */
export function requireProjectByName(name: string, registry: ProjectConfig[] = PROJECT_REGISTRY): ProjectConfig {
  const project = resolveProjectByName(name, registry);
  if (!project) throw new UnknownProjectError(name, registry);
  return project;
}

/**
 * Mined rule 1 ("never begin implementation without a ticket reference"):
 * checks a finding/plan description against the project's `ticketPattern`.
 * Pure predicate -- callers decide what to do with `false` (e.g. the CLI
 * throws; a dashboard form might instead show a validation message).
 */
export function hasTicketReference(project: ProjectConfig, description: string): boolean {
  return project.ticketPattern.test(description);
}

/**
 * The subset of `PlanPipelineOptions` (`@pros/plan`) a `ProjectConfig`
 * actually determines. Callers spread this into the rest of their
 * run-specific options (worktreesRoot, runsRoot, runId, sessions, ...) --
 * this module deliberately does not import `PlanPipelineOptions` itself to
 * avoid a hard type-level coupling that would need updating every time that
 * interface grows a field unrelated to project identity.
 */
export function planOptionsForProject(project: ProjectConfig, description: string): { repoRoot: string; description: string } {
  return { repoRoot: project.repoRoot, description };
}

/**
 * The subset of `Gate2PipelineOptions` (`./pipeline.ts`) a `ProjectConfig`
 * determines: where to find the repo, which files implementation is allowed
 * to touch, and (optionally) which brief files to load instead of the
 * default `.claude/agents/scoped-fixer.md` / `.claude/skills/review/SKILL.md`
 * convention. Same "don't import the full interface" reasoning as
 * `planOptionsForProject` above.
 */
export function gate2OptionsForProject(project: ProjectConfig): {
  repoRoot: string;
  fileAllowlist: string[];
  agentBriefPath?: string;
  reviewSkillPath?: string;
} {
  return {
    repoRoot: project.repoRoot,
    fileAllowlist: project.defaultFileAllowlist,
    agentBriefPath: project.agentBriefPath,
    reviewSkillPath: project.reviewSkillPath,
  };
}
