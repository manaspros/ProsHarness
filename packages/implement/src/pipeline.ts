/**
 * pipeline.ts -- ties implement -> verify -> review -> draft PR -> parkForGate2
 * together (M4 Gate 2 pipeline), and the PR-ops reconcile helper `pros
 * reconcile` calls.
 *
 * Mirrors the shape of packages/plan/src/pipeline.ts's `runPlanPipeline`
 * closely: same Barrier.open/conditional wireNtfyNotifications/close
 * discipline, same idempotent-park pattern, just calling `barrier.parkForGate2` instead of
 * `parkForGate1`.
 *
 * ---- Design choices worth being explicit about ----
 *
 * `ghCredential` derivation: if the caller doesn't pass one, this module
 * derives "owner/repo" from `git remote get-url origin` in `worktreePath`
 * and calls `loadCredentialFromEnv(repo)`. This keeps the common case
 * (a single real remote) zero-config while still letting tests inject an
 * explicit credential without touching a real git remote.
 *
 * PR-ops journal entries (`pr_create_intent` / `pr_created`): `@pros/barrier`'s
 * `JournalEntry` is a closed discriminated union, and per this project's
 * house style (docs/00-decisions.md D12, "tolerant parsing") we do NOT edit
 * that package's types just to add these two kinds. Instead this module
 * writes them via `Journal.append()` with a local, structurally-compatible
 * object cast at the boundary, and reads them back via `Journal.read()`
 * treated as `Array<Record<string, unknown>>` rather than the typed
 * `JournalEntry[]` -- unknown kinds already pass through `Journal`/`RunState`
 * projection untouched (see run-state.ts's `default: break`), so this is
 * exactly the same tolerance the rest of the system already relies on, just
 * exercised deliberately here rather than incidentally.
 *
 * The intent entry additionally carries a `repo` field (not in the original
 * design sketch) -- `reconcilePrOps` needs to know which repo/credential a
 * given intent belongs to, and the journal is the only durable place that
 * information can live per-run, so it is recorded at intent time.
 */

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Barrier, Journal, loadRunState, git } from "@pros/barrier";
import { wireNtfyNotifications } from "@pros/notify";
import type { ModelSession } from "@pros/plan";
import { RealClaudeSession, RealCodexSession } from "@pros/plan";
import { ConcurrencyLease, TokenCeiling } from "@pros/lease";
import {
  type GhClient,
  type PrHandle,
  type GhCredential,
  RealGhClient,
  AmbientGhClient,
  loadCredentialFromEnv,
  checkGhAuthenticated,
} from "./pr.js";
import { assertImplementationScope, runImplementation, type ImplementResult } from "./implement.js";
import { claimGate2 } from "./from-run.js";
import { runVerification, noCommitVerdict, type Verdict } from "./verify.js";
import { runAdversarialReview, runCodexAdvisoryReview, type ReviewResult, type CodexAdvisoryResult } from "./review.js";
import { resolveProjectByRepoRoot, type ValidationCommand } from "./project-config.js";

/**
 * Same reasoning and exact fallback commands as implement.ts's own
 * `FALLBACK_VALIDATION_COMMANDS` (not exported from there, and
 * `implement.ts` is out of this phase's edit surface -- see this package's
 * concurrent-agent constraints) -- a run against an unregistered/ad-hoc
 * target repo still needs SOMETHING to verify against, and ProsHarness's own
 * two Quick Commands are a real, working default, not an empty placeholder.
 */
const FALLBACK_VALIDATION_COMMANDS: ValidationCommand[] = [
  { command: "pnpm run typecheck", label: "typecheck (fallback: no project resolved)" },
  { command: "pnpm run test", label: "test (fallback: no project resolved)" },
];

/** Parses "owner/repo" out of a git remote URL, both SSH and HTTPS forms. */
function parseOwnerRepo(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/[:/]([^/:]+\/[^/]+?)(\.git)?\/?$/);
  if (!match) {
    throw new Error(`runGate2Pipeline: could not derive "owner/repo" from remote url: ${trimmed}`);
  }
  return match[1]!;
}

async function deriveRepoSlug(worktreePath: string): Promise<string> {
  const url = await git(worktreePath, ["remote", "get-url", "origin"]);
  return parseOwnerRepo(url);
}

function emptyReview(): ReviewResult {
  return { objections: [], verdict: "approve", unresolvedBlockers: [] };
}

export interface Gate2PipelineOptions {
  runId: string;
  /** <runsRoot>/<runId>, already exists from Gate 1. */
  runDir: string;
  worktreePath: string;
  branch: string;
  /** e.g. "main". */
  baseBranch: string;
  repoRoot: string;
  planMarkdown: string;
  fileAllowlist: string[];
  /** Named-project override for the implementer brief; see implement.ts's `ImplementInput.agentBriefPath`. Omitted keeps today's `.claude/agents/scoped-fixer.md` default. */
  agentBriefPath?: string;
  /** Named-project override for the review skill; see review.ts's `ReviewInput.reviewSkillPath`. Omitted keeps today's `.claude/skills/review/SKILL.md` default. */
  reviewSkillPath?: string;
  /** Defaults to new RealClaudeSession(). */
  claudeSession?: ModelSession;
  /** Defaults to new RealCodexSession(). */
  codexSession?: ModelSession;
  /** Defaults to a SEPARATE new RealClaudeSession() instance -- never sharing a resumeSessionId with claudeSession. */
  verifierSession?: ModelSession;
  /**
   * Explicit override for the harness-spawned validation commands verify.ts
   * runs. When omitted, resolved from `PROJECT_REGISTRY` via
   * `resolveProjectByRepoRoot(worktreeParentRepo ?? repoRoot)` (same
   * resolution as implement.ts's own --allowedTools lookup), falling back to
   * `FALLBACK_VALIDATION_COMMANDS` when unregistered. Mainly for tests that
   * want fast, deterministic pass/fail commands instead of a real project's
   * actual build/test suite.
   */
  validationCommands?: ValidationCommand[];
  /**
   * Defaults to `new RealGhClient()` if `PROS_GH_PR_TOKEN` is set (today's
   * behavior, unchanged); otherwise defaults to `new AmbientGhClient()` (the
   * zero-token path -- see pr.ts's "AMBIENT PATH" doc comment), after running
   * `checkGhAuthenticated()` as a preflight.
   */
  ghClient?: GhClient;
  /**
   * Defaults to `loadCredentialFromEnv(<owner/repo derived from `git remote
   * get-url origin`>)` when `PROS_GH_PR_TOKEN` is set; otherwise defaults to
   * `{ repo: <same owner/repo> }` (an `AmbientGhCredential`), paired with the
   * `AmbientGhClient` default above.
   */
  ghCredential?: GhCredential;
  /** If given, acquire+heartbeat+release a ConcurrencyLease around the whole pipeline; if omitted, skip lease entirely. */
  leaseDir?: string;
  /** Required if leaseDir given. */
  maxConcurrent?: number;
  /** Shared across implement/verify/review stages. */
  tokenCeiling?: TokenCeiling;
  ntfyUrl?: string;
  /**
   * Passed straight through to `wireNtfyNotifications({ slackTarget })`.
   * Only relevant when `ntfyUrl`/PROS_NTFY_URL is NOT set -- in that case
   * the notifier falls back to a Slack DM via the connected Slack MCP
   * server, and this optionally redirects it to a specific channel/user
   * instead of the default "DM yourself". If undefined, the fallback reads
   * process.env.PROS_SLACK_NOTIFY_TARGET, mirroring ntfyUrl's own fallback.
   */
  slackTarget?: string;
  /**
   * External notifications are opt-in at the orchestration entry point.
   * Reusable/library calls and tests remain silent unless a real caller
   * explicitly enables them.
   */
  notificationsEnabled?: boolean;
  /**
   * If true, remove the local worktree directory (`git worktree remove
   * --force` + `git worktree prune`) once Gate 2 successfully parks --
   * safe at that point because the branch is already pushed and a PR now
   * references it, so the local worktree is no longer the durable record
   * of this work. Defaults to false so callers/tests that pass an
   * unrelated `repoRoot` (e.g. only for loading `.claude/agents`/`.claude/skills`
   * briefs, decoupled from the worktree's actual parent repo) are
   * unaffected. Real orchestration call sites (the CLI, the M4 e2e test)
   * should pass `true` with `worktreeParentRepo` set to the worktree's
   * actual originating repo.
   */
  reapWorktreeOnSuccess?: boolean;
  /** The worktree's actual originating repo (where `git worktree add` was run from) -- defaults to `repoRoot`. Only used when `reapWorktreeOnSuccess` is true. */
  worktreeParentRepo?: string;
  /** Permission policy selected for the run; the implementation context is fresh but uses the same explicit policy. */
  dangerouslySkipPermissions?: boolean;
  /**
   * The plan's own one-line, plain-language claim (`@pros/plan`'s structured
   * plan schema, `packages/plan/src/plan.ts`). Wired by
   * `deriveGate2OptionsFromRun` (packages/implement/src/from-run.ts) off the
   * finalized plan's `structuredJson` in the journal -- optional and
   * undefined for runs planned before that schema existed, or when the field
   * is blank/absent. When present, it becomes the PR title source (see
   * `derivePrTitleSource`) and the `## Summary` section; when absent, the PR
   * title/body derive from `planMarkdown`'s own first line instead, which is
   * degrading gracefully, not a bug.
   */
  planClaim?: string;
  /**
   * The plan's own mermaid diagram source (`@pros/plan`'s `diagram` field,
   * same provenance and same-caveat as `planClaim` above). When present and
   * non-blank, it becomes the draft PR body's diagram section verbatim
   * (GitHub renders mermaid natively -- no rendering library involved). When
   * absent or blank, the diagram section is omitted entirely -- never an
   * empty or broken fence.
   */
  planDiagram?: string;
}

/**
 * Mined rule 3 ("no ticket IDs in PR titles/bodies/commit messages"),
 * enforced here rather than only documented: matches an uppercase
 * alpha(-numeric) project-key prefix + hyphen + digits (e.g. `AGENT-1234`,
 * `ENGOPS-456`, `ZD-1234`, `JIRA-123`), optionally wrapped in `[...]`/`(...)`.
 * Generic on purpose -- this module has no registry of "real" ticket
 * prefixes and must not need one to do the stripping.
 */
const TICKET_ID_RE = /[[(]?\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b[\])]?/g;

/** The verb:object shape used when a project doesn't declare its own `ProjectConfig.prTitlePattern`. */
const DEFAULT_PR_TITLE_PATTERN = /^[a-z][a-z0-9-]*: .+/;

/** Thrown by `derivePrTitle` when no shape of the plan's own words can be made to satisfy the project's title pattern -- fails loudly rather than opening a badly-titled PR. */
export class PrTitleValidationError extends Error {
  constructor(candidate: string, pattern: RegExp) {
    super(`derived PR title ${JSON.stringify(candidate)} does not match required pattern ${pattern}`);
    this.name = "PrTitleValidationError";
  }
}

/** Strips ticket IDs (see `TICKET_ID_RE`) and collapses the whitespace that removing one leaves behind. Applied to every free-text field this module writes into a PR title or body. */
export function stripTicketIds(text: string): string {
  return text
    .replace(TICKET_ID_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Collapses a piece of model-/plan-generated free text to a single safe
 * inline markdown line: newlines (which could otherwise start a fake
 * heading, list item, or code fence at the start of a line) are flattened
 * to spaces, ticket IDs are stripped, and the result is trimmed and bounded.
 * NOT used for the diagram block -- that goes through `fenceMermaid`
 * instead, since a fenced block's escape mechanism (more backticks than any
 * run inside the content) is different from "flatten to one line".
 */
export function toSafeInline(text: string, maxLen = 400): string {
  const flattened = stripTicketIds(text.replace(/\r?\n/g, " ")).replace(/[ \t]{2,}/g, " ").trim();
  return flattened.length > maxLen ? `${flattened.slice(0, maxLen - 3)}...` : flattened;
}

/**
 * Picks the plan's own words to build a title from -- `planClaim` if a
 * caller has wired one through (see `Gate2PipelineOptions.planClaim`),
 * otherwise the first non-blank line of `planMarkdown` with a leading
 * markdown heading marker stripped. Never invents new text.
 */
export function derivePrTitleSource(opts: { planClaim?: string; planMarkdown: string }): string {
  if (opts.planClaim && opts.planClaim.trim().length > 0) {
    return opts.planClaim.trim();
  }
  const lines = opts.planMarkdown
    .split("\n")
    .map((l) => l.trim().replace(/^#+\s*/, ""))
    .filter((l) => l.length > 0);
  // A bare one-word heading (e.g. "# Plan") is a document label, not the
  // plan's own claim -- prefer the first line with real content (>= 2
  // words) and only fall back to a one-word line if nothing better exists.
  return lines.find((l) => l.split(/\s+/).length >= 2) ?? lines[0] ?? "";
}

/**
 * Builds a `verb: object` PR title out of the plan's own words (never
 * invented text) and validates it against `pattern`
 * (`ProjectConfig.prTitlePattern`, or `DEFAULT_PR_TITLE_PATTERN` when a
 * project doesn't declare one). Ticket IDs are stripped first. If the
 * source text isn't already in `verb: object` shape, the first
 * whitespace-delimited token becomes the (lowercased) verb and the rest
 * becomes the object -- a light reshaping of the SAME words, not new
 * content. Throws `PrTitleValidationError` (rather than silently opening a
 * badly-titled PR) if no such reshaping satisfies `pattern`.
 */
export function derivePrTitle(source: string, pattern: RegExp = DEFAULT_PR_TITLE_PATTERN): string {
  const cleaned = stripTicketIds(source.replace(/\r?\n/g, " ")).replace(/[ \t]{2,}/g, " ").trim();
  if (pattern.test(cleaned)) {
    return cleaned;
  }

  const spaceIdx = cleaned.indexOf(" ");
  let reshaped = cleaned;
  if (spaceIdx > 0) {
    const verb = cleaned.slice(0, spaceIdx).toLowerCase().replace(/[^a-z0-9-]/g, "");
    const object = cleaned.slice(spaceIdx + 1).trim();
    if (verb.length > 0 && object.length > 0) {
      reshaped = `${verb}: ${object}`;
    }
  }

  if (pattern.test(reshaped)) {
    return reshaped;
  }
  throw new PrTitleValidationError(reshaped, pattern);
}

/**
 * Wraps `content` in a mermaid-tagged fenced code block using a backtick
 * run one longer than the longest backtick run already inside `content` --
 * the standard CommonMark technique for making a fence un-closeable by
 * content it wraps, applied here specifically so a plan-generated diagram
 * containing its own ``` cannot break out of the block. Returns undefined
 * (never an empty/broken fence) when `content` is absent or blank, so
 * callers can `if (block) bodyParts.push(block)` and cleanly omit the whole
 * diagram section.
 */
export function fenceMermaid(content: string | undefined): string | undefined {
  if (!content || content.trim().length === 0) return undefined;
  const trimmed = content.trim();
  const longestRun = Math.max(0, ...(trimmed.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}mermaid\n${trimmed}\n${fence}`;
}

/**
 * Renders the per-command validation evidence for the PR body. Exit codes,
 * labels, and durations only -- deliberately NOT `CheckResult.outputTail`.
 * `outputTail` is already best-effort secret-redacted (`redactSecrets` in
 * validation-commands.ts), but that redaction is pattern-based and
 * incomplete by nature; the PR body is pushed to GitHub, an outbound
 * channel, so this module treats exit codes/durations/counts as the
 * reviewable evidence and leaves raw command output in the journal (which a
 * human reviewer with run access can still open) rather than re-publishing
 * it somewhere with weaker redaction guarantees.
 *
 * Only `role: "gate"` validation_command_run evidence exists today (see
 * verify.ts/pipeline.ts) -- "reproduce_before"/"reproduce_after" are
 * reserved for a future phase's before/after-the-fix flow that isn't built.
 * This function therefore always renders reproduction status as explicitly
 * "not established", never as a pass and never silently omitted -- absence
 * of that evidence must never read as "fine".
 */
export function renderVerificationSection(verdict: Verdict): string {
  const lines: string[] = [];
  const outcomeLabel = verdict.outcome === "pass" ? "PASS" : "FAIL";
  lines.push(`Gate verdict: **${outcomeLabel}** -- ${toSafeInline(verdict.summary, 300)}`);
  lines.push("");
  if (verdict.noValidationCommandsConfigured) {
    lines.push("_No validation commands are configured for this project -- the verdict above is vacuously pass, not a measured one._");
  } else if (verdict.checks.length > 0) {
    lines.push("| Command | Exit code | Duration | Timed out |");
    lines.push("| --- | --- | --- | --- |");
    for (const check of verdict.checks) {
      const label = toSafeInline(check.label ?? check.command, 120).replace(/\|/g, "\\|");
      lines.push(`| ${label} | ${check.exitCode} | ${check.durationMs}ms | ${check.timedOut ? "yes" : "no"} |`);
    }
  }
  lines.push("");
  lines.push(
    "Reproduced before the fix: **not established** -- this run only ever records `role: \"gate\"` evidence (the full validation suite, run once after the fix). No before/after reproduction was captured.",
  );
  return lines.join("\n");
}

/**
 * Renders the advisory-only Codex review section. `unavailable` never
 * renders as reviewed-and-clean -- it is its own distinct, explicit state,
 * same for a project that opted the pass out entirely (`codexAdvisory`
 * undefined). This review never gates the PR either way; the section says
 * so explicitly so a human reviewer doesn't mistake "advisory, no blocker"
 * for a second required approval.
 */
export function renderCodexAdvisorySection(codexAdvisory: CodexAdvisoryResult | undefined): string {
  if (!codexAdvisory) {
    return "Not run for this project (`ProjectConfig.codexAdvisoryReviewDisabled`). Advisory only either way -- absence here is not a finding.";
  }
  if (codexAdvisory.status === "unavailable") {
    return `**Unavailable** -- ${toSafeInline(codexAdvisory.unavailableReason ?? "no reason recorded", 300)}. This is NOT a clean review; it is an absence of one.`;
  }
  if (codexAdvisory.status === "reviewed_blocker") {
    const findings = codexAdvisory.findings
      .map((f) => `- **[${f.severity}]** ${toSafeInline(f.claim, 300)}`)
      .join("\n");
    return `Reviewed -- advisory blocker(s) raised (does not block this PR, advisory only):\n\n${findings}`;
  }
  return "Reviewed -- no blocker raised (advisory only).";
}

export interface BuildPrContentInput {
  runId: string;
  planClaim?: string;
  planMarkdown: string;
  planDiagram?: string;
  verdict: Verdict;
  codexAdvisory: CodexAdvisoryResult | undefined;
  unresolvedNonBlockers: ReviewResult["objections"];
  prTitlePattern?: RegExp;
}

export interface BuiltPrContent {
  title: string;
  body: string;
}

/**
 * The single place title+body are assembled -- exported so tests can drive
 * it directly with fixture inputs instead of running a whole pipeline.
 *
 * Title derivation degrades in two steps, never opting straight for a hard
 * failure just because a caller started passing `planClaim`: try the claim
 * first (it is the more human-legible source), but if it isn't reshapeable
 * into `pattern` (e.g. a single word, or something `derivePrTitle` can't
 * turn into `verb: object`), fall back to the markdown-derived source that
 * worked before this field existed. Only if BOTH sources fail to satisfy
 * `pattern` does this rethrow -- a run that opened fine pre-wiring must not
 * start throwing at PR-open time purely because a claim got populated.
 */
export function buildPrContent(input: BuildPrContentInput): BuiltPrContent {
  const pattern = input.prTitlePattern ?? DEFAULT_PR_TITLE_PATTERN;
  const titleSource = derivePrTitleSource({ planClaim: input.planClaim, planMarkdown: input.planMarkdown });
  let title: string;
  try {
    title = derivePrTitle(titleSource, pattern);
  } catch (err) {
    if (!(err instanceof PrTitleValidationError) || !input.planClaim) throw err;
    // The claim didn't reshape cleanly -- retry from planMarkdown alone,
    // exactly the source a caller without a claim would have used.
    const markdownSource = derivePrTitleSource({ planMarkdown: input.planMarkdown });
    title = derivePrTitle(markdownSource, pattern);
  }

  const sections: string[] = [];

  const claimText = toSafeInline(input.planClaim ?? titleSource, 500);
  sections.push("## Summary", "", claimText || "_(no plan summary available)_");

  const diagramBlock = fenceMermaid(input.planDiagram);
  if (diagramBlock) {
    sections.push("", "## Diagram", "", diagramBlock);
  }

  sections.push("", "## Verification", "", renderVerificationSection(input.verdict));
  sections.push("", "## Codex advisory review", "", renderCodexAdvisorySection(input.codexAdvisory));

  if (input.unresolvedNonBlockers.length > 0) {
    sections.push(
      "",
      "## Unresolved review objections",
      "",
      "Major/minor -- not blocking, but visible for the human reviewer:",
      "",
      ...input.unresolvedNonBlockers.map(
        (o) => `- **[${o.severity}]** ${toSafeInline(o.claim, 300)} -- suggested: ${toSafeInline(o.suggested_change, 300)}`,
      ),
    );
  }

  // Mandatory per the mined-rule PR template -- always present, never
  // conditional on whether anything in this run actually touched an
  // AGENTS.md/CLAUDE.md file, so a reviewer always has to answer it rather
  // than the section quietly disappearing when it's most needed.
  sections.push("", "## AGENTS.md delta?", "", "- [ ] Does this change need an AGENTS.md/CLAUDE.md update? (reviewer to confirm)");

  sections.push("", `_Run: \`${toSafeInline(input.runId, 200)}\`_`);

  return { title, body: sections.join("\n") };
}

export interface Gate2PipelineResult {
  implementResult: ImplementResult;
  verdict: Verdict;
  review: ReviewResult;
  /**
   * Phase 6: the SEPARATE, advisory-only Codex pass over the risk-ranked
   * hunks + approved plan (see review.ts's `runCodexAdvisoryReview`).
   * Undefined only when verification failed before this stage ever ran, or
   * the project opted out via `ProjectConfig.codexAdvisoryReviewDisabled`.
   * Never gates anything -- `status: "unavailable"` is a recorded, honest
   * absence, not a synthesized approval.
   */
  codexAdvisory?: CodexAdvisoryResult;
  /** undefined if verification failed or review had unresolved blockers -- NO PR is opened in that case. */
  pr?: PrHandle;
  /** Set only once parkForGate2 succeeds (i.e. pr is defined). */
  checkpointId?: string;
  questionId?: string;
  /** Set when the pipeline stops short of a PR. */
  aborted?: { stage: "verify" | "review"; reason: string };
  /**
   * True once the local worktree directory has been removed (`git worktree
   * remove`) after a successful Gate 2 park. Safe at this point because the
   * durable record of the work is now the pushed branch + open PR, not the
   * local worktree copy (D14: "at session end, clean up once work is pushed
   * to a PR"). Best-effort: a failure here does NOT fail the pipeline or
   * lose the PR/Gate-2 checkpoint that already succeeded -- it is reported
   * via `worktreeReapError` and left for `pros reconcile` to pick up later,
   * per D22 ("nothing force-deleted by us... orphans surfaced by reconcile
   * and cleaned only with confirmation" -- here the "confirmation" is that
   * the branch is already safely pushed and PR-referenced).
   */
  worktreeReaped?: boolean;
  worktreeReapError?: string;
}

export async function runGate2Pipeline(opts: Gate2PipelineOptions): Promise<Gate2PipelineResult> {
  // The implementation scope is security policy, not an optional hint. Check
  // it before acquiring resources so malformed/empty runtime input cannot
  // reach any model or become an unrestricted run.
  assertImplementationScope(opts.fileAllowlist);

  let lease: ConcurrencyLease | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let journal: Journal | undefined;

  if (opts.leaseDir) {
    if (opts.maxConcurrent === undefined) {
      throw new Error("runGate2Pipeline: maxConcurrent is required when leaseDir is given");
    }
    lease = await ConcurrencyLease.acquire({
      leaseDir: opts.leaseDir,
      maxConcurrent: opts.maxConcurrent,
      runId: opts.runId,
    });
    // Mirrors Barrier.startAttempt's heartbeat timer: unref'd so it never
    // keeps the process alive.
    heartbeatTimer = setInterval(() => {
      lease?.heartbeat().catch(() => undefined);
    }, 2000);
    heartbeatTimer.unref();
  }

  try {
    // Gate 2 runs are unattended too. Keep the permission policy enforced at
    // the production pipeline boundary so every fresh implementation,
    // verification, and review Claude session gets the same behavior even if
    // an older caller omitted the option.
    const dangerouslySkipPermissions = true;
    const claudeSession = opts.claudeSession ?? new RealClaudeSession();
    const codexSession = opts.codexSession ?? new RealCodexSession();
    const verifierSession = opts.verifierSession ?? new RealClaudeSession();

    // Precedence: if PROS_GH_PR_TOKEN is set, keep today's exact behavior
    // (RealGhClient + loadCredentialFromEnv) -- the stronger, server-enforced
    // path. If it is NOT set, fall back to the zero-token ambient path
    // (AmbientGhClient), after a preflight that fails fast (before spending
    // time on implement/verify/review) if the operator's ambient `gh` session
    // isn't actually authenticated either. Either half is independently
    // overridable via explicit `ghClient`/`ghCredential` options, exactly as
    // before -- this is what lets tests inject `LocalGhStub`/local ambient
    // stubs without touching real env state or a real `gh` binary.
    const usingScopedToken = !!process.env.PROS_GH_PR_TOKEN;
    let ghClient: GhClient;
    if (opts.ghClient) {
      ghClient = opts.ghClient;
    } else if (usingScopedToken) {
      ghClient = new RealGhClient();
    } else {
      await checkGhAuthenticated();
      ghClient = new AmbientGhClient();
    }

    // This durable, journal-serialized claim covers every Gate 2 entry point
    // that calls runGate2Pipeline, including the CLI and scheduler. The
    // callers' read-only duplicate checks remain useful for fast refusal, but
    // this is the race-safe decision point.
    await claimGate2(opts.runDir, opts.runId);

    const fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;

    // Opened once, here, and reused for the whole function (rather than the
    // narrower open done right before the PR-intent append further down) so
    // the verdict/review journal entries added below -- which must be
    // recorded even on the early-return/abort paths -- have a handle to
    // write through. Same `journal.append({...} as any)` tolerant-parsing
    // pattern as pr_create_intent/pr_created (see file doc comment): these
    // are ad-hoc `kind`s outside @pros/barrier's closed JournalEntry union,
    // and unknown kinds already pass through Journal/RunState untouched.
    journal = await Journal.open(opts.runDir);

    const implementResult = await runImplementation({
      claudeSession,
      worktreePath: opts.worktreePath,
      branch: opts.branch,
      planMarkdown: opts.planMarkdown,
      fileAllowlist: opts.fileAllowlist,
      runId: opts.runId,
      attemptId: `${opts.runId}-implement`,
      repoRoot: opts.repoRoot,
      // The implement stage resolves its own project (for validationCommands
      // -> --allowedTools) from the ORIGINATING target repo, not ProsHarness's
      // own repoRoot -- see ImplementInput.projectRepoRoot's doc comment.
      projectRepoRoot: opts.worktreeParentRepo,
      agentBriefPath: opts.agentBriefPath,
      tokenCeiling: opts.tokenCeiling,
      dangerouslySkipPermissions,
      rawLogPath: path.join(opts.runDir, "attempts", `${opts.runId}-implement`, "raw.log"),
    });

    if (!implementResult.committed) {
      // Keep the aborted result durable just like a verifier failure below.
      // claimGate2 uses this existing result event to distinguish a completed
      // claim from a claim left behind by a failed implementation attempt.
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "verify_verdict",
        outcome: "fail",
        summary: "implementation produced no commit",
        failingChecksJson: JSON.stringify([]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return {
        implementResult,
        verdict: noCommitVerdict("implementation produced no commit"),
        review: emptyReview(),
        aborted: { stage: "verify", reason: "implementation produced no commit" },
      };
    }

    // Same resolution as implement.ts's own project lookup (see
    // ImplementInput.projectRepoRoot's doc comment): the ORIGINATING target
    // repo (worktreeParentRepo), not ProsHarness's own repoRoot, is what
    // determines this project's real validation commands. An explicit
    // `opts.validationCommands` override skips resolution entirely.
    let validationCommands: ValidationCommand[];
    if (opts.validationCommands) {
      validationCommands = opts.validationCommands;
    } else {
      const projectLookupRoot = opts.worktreeParentRepo ?? opts.repoRoot;
      const project = resolveProjectByRepoRoot(projectLookupRoot);
      if (project) {
        validationCommands = project.validationCommands;
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `runGate2Pipeline: no registered project for repoRoot ${JSON.stringify(projectLookupRoot)} -- falling back to ProsHarness's own typecheck/test commands. ` +
            `Add an entry to PROJECT_REGISTRY (packages/implement/src/project-config.ts) to grant this project's real commands.`,
        );
        validationCommands = FALLBACK_VALIDATION_COMMANDS;
      }
    }

    const verdict = await runVerification({
      verifierSession,
      worktreePath: opts.worktreePath,
      runId: opts.runId,
      runDir: opts.runDir,
      expectedFenceEpoch: fenceEpoch,
      attemptId: `${opts.runId}-verify`,
      validationCommands,
      rawLogPath: path.join(opts.runDir, "attempts", `${opts.runId}-verify`, "raw.log"),
      tokenCeiling: opts.tokenCeiling,
      dangerouslySkipPermissions,
    });

    // Durably record the verdict BEFORE checking outcome, so a failing
    // verdict is journaled exactly as reliably as a passing one -- "a run
    // that dropped a verification-failed event must never look healthy" is
    // a standing project invariant, and the M5 review page needs this as a
    // recorded fact, not an in-memory-only inference.
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "verify_verdict",
      outcome: verdict.outcome,
      summary: verdict.summary,
      failingChecksJson: JSON.stringify(verdict.failingChecks),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // One `validation_command_run` event PER harness-recorded check --
    // separate from `verify_verdict` (whose shape is preserved unchanged
    // above) so this phase adds evidence without touching that existing
    // event's schema. This is the granular, per-command exit-code evidence
    // a future decision-card UI needs for "Gates green" / "Reproduced" /
    // "Fix proven" -- see verify.ts's file doc comment.
    for (const check of verdict.checks) {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "validation_command_run",
        attemptId: `${opts.runId}-verify`,
        command: check.command,
        label: check.label,
        // "gate" = this phase's only producer: the full configured
        // validation-command list run once, after the fix already landed.
        // "reproduce_before"/"reproduce_after" are reserved for a future
        // phase's before/after-the-fix flow (not built here) -- pairing by
        // (runId, command, role) is unambiguous once that flow exists,
        // without this event's shape needing to change.
        role: "gate",
        exitCode: check.exitCode,
        timedOut: check.timedOut,
        durationMs: check.durationMs,
        outputTail: check.outputTail,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    if (verdict.outcome === "fail") {
      return {
        implementResult,
        verdict,
        review: emptyReview(),
        aborted: { stage: "verify", reason: verdict.summary },
      };
    }

    const review = await runAdversarialReview({
      claudeSession,
      codexSession,
      worktreePath: opts.worktreePath,
      repoRoot: opts.repoRoot,
      reviewSkillPath: opts.reviewSkillPath,
      baseSha: implementResult.baseSha,
      headSha: implementResult.headSha,
      planMarkdown: opts.planMarkdown,
      runId: opts.runId,
      attemptIdPrefix: opts.runId,
      tokenCeiling: opts.tokenCeiling,
      dangerouslySkipPermissions,
      rawLogPathForAttempt: (attemptId) => path.join(opts.runDir, "attempts", attemptId, "raw.log"),
    });

    // Same reasoning as verify_verdict above: recorded before the
    // blockers-present check, unconditionally, so it's a durable fact
    // regardless of whether the pipeline goes on to open a PR.
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "review_completed",
      verdict: review.verdict,
      objectionsJson: JSON.stringify(review.objections),
      unresolvedBlockersJson: JSON.stringify(review.unresolvedBlockers),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // ---- Codex advisory review (Phase 6) ----
    //
    // A SEPARATE pass from `runAdversarialReview` above: this one is
    // read-only and advisory-only (see review.ts's file doc comment) and
    // must never affect the blockers-present check above or gate PR
    // creation below. Runs regardless of that check's outcome -- an
    // advisory opinion on a diff the pipeline is about to abort on is still
    // useful to a human looking at `aborted.reason` later -- unless the
    // project explicitly opted out.
    const projectForAdvisory = resolveProjectByRepoRoot(opts.worktreeParentRepo ?? opts.repoRoot);
    let codexAdvisory: CodexAdvisoryResult | undefined;
    if (!projectForAdvisory?.codexAdvisoryReviewDisabled) {
      const codexAdvisoryAttemptId = `${opts.runId}-codex-advisory-review`;
      codexAdvisory = await runCodexAdvisoryReview({
        worktreePath: opts.worktreePath,
        branch: opts.branch,
        baseSha: implementResult.baseSha,
        headSha: implementResult.headSha,
        planMarkdown: opts.planMarkdown,
        attemptId: codexAdvisoryAttemptId,
        rawLogPath: path.join(opts.runDir, "attempts", codexAdvisoryAttemptId, "raw.log"),
      }).catch((err) => ({
        status: "unavailable" as const,
        findings: [],
        unavailableReason: `runCodexAdvisoryReview threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }));

      // Recorded unconditionally, same reasoning as verify_verdict/
      // review_completed above -- an advisory pass that never ran, or that
      // came back "unavailable", must be a durable, honest fact, not
      // silently absent from the journal.
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "codex_advisory_review",
        status: codexAdvisory.status,
        findingsJson: JSON.stringify(codexAdvisory.findings),
        unavailableReason: codexAdvisory.unavailableReason,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    if (review.verdict === "blockers-present") {
      return {
        implementResult,
        verdict,
        review,
        codexAdvisory,
        aborted: { stage: "review", reason: `${review.unresolvedBlockers.length} unresolved blocker(s)` },
      };
    }

    // ---- Open the draft PR ----

    const cred: GhCredential =
      opts.ghCredential ??
      (usingScopedToken
        ? loadCredentialFromEnv(await deriveRepoSlug(opts.worktreePath))
        : { repo: await deriveRepoSlug(opts.worktreePath) });

    const unresolvedNonBlockers = review.objections.filter((o) => o.severity !== "blocker");
    // `projectForAdvisory` (resolved above, same repo lookup the Codex
    // advisory pass used) is also this run's source for
    // `ProjectConfig.prTitlePattern` -- one resolution, two consumers,
    // rather than resolving the project twice.
    const { title, body } = buildPrContent({
      runId: opts.runId,
      planClaim: opts.planClaim,
      planMarkdown: opts.planMarkdown,
      planDiagram: opts.planDiagram,
      verdict,
      codexAdvisory,
      unresolvedNonBlockers,
      prTitlePattern: projectForAdvisory?.prTitlePattern,
    });

    const prIntentId = randomUUID();
    const prIdempotencyKey = `pr-${opts.runId}`;

    // Journal the intent step FIRST, before the `gh` call -- so a crash
    // between "we tried" and "we know if it worked" is detectable by
    // reconcilePrOps below.
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "pr_create_intent",
      prIntentId,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      idempotencyKey: prIdempotencyKey,
      repo: cred.repo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const pr = await ghClient.createDraftPr(cred, {
      cwd: opts.worktreePath,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      title,
      body,
    });

    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "pr_created",
      prIntentId,
      url: pr.url,
      number: pr.number,
      headSha: pr.headSha,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const barrier = await Barrier.open(opts.runDir, opts.runId);
    let checkpointId: string;
    let questionId: string;
    try {
      const unsubscribe = opts.notificationsEnabled
        ? wireNtfyNotifications(barrier, { url: opts.ntfyUrl, slackTarget: opts.slackTarget })
        : () => undefined;
      try {
        const freshQuestionId = randomUUID();
        const gate2IdempotencyKey = `gate2-${opts.runId}`;
        const result = await barrier.parkForGate2({
          cwd: opts.worktreePath,
          prompt: `Draft PR #${pr.number} for run ${opts.runId}: verification ${verdict.outcome}, review ${review.verdict}.`,
          options: ["reviewed"],
          questionId: freshQuestionId,
          idempotencyKey: gate2IdempotencyKey,
          prRef: { url: pr.url, number: pr.number, headSha: pr.headSha },
        });
        checkpointId = result.checkpointId;
        // Same idempotent-replay reasoning as runPlanPipeline: on a replayed
        // call the ORIGINAL questionId (not freshQuestionId) is what's
        // actually resolvable via `pros answer`.
        questionId = barrier.getState().checkpoints.get(checkpointId)?.questionId ?? freshQuestionId;
      } finally {
        unsubscribe();
      }
    } finally {
      await barrier.close();
    }

    // ---- Reap the local worktree ----
    //
    // The branch is already pushed (a precondition for `createDraftPr`
    // above) and a PR now references it, so the local worktree copy is no
    // longer the durable record of this work -- it's safe to remove. This
    // is deliberately best-effort: if it fails for any reason, the pipeline
    // still returns success (the PR and Gate 2 checkpoint are what matter),
    // and the now-orphaned worktree is left for `pros reconcile` to find
    // and clean up later (WorktreeAllocator.reconcile() already treats a
    // directory git no longer needs to track as a rollback candidate).
    let worktreeReaped = false;
    let worktreeReapError: string | undefined;
    if (opts.reapWorktreeOnSuccess) {
      const parentRepo = opts.worktreeParentRepo ?? opts.repoRoot;
      try {
        await git(parentRepo, ["worktree", "remove", "--force", opts.worktreePath]);
        await git(parentRepo, ["worktree", "prune"]);
        worktreeReaped = true;
      } catch (err) {
        worktreeReapError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      implementResult,
      verdict,
      review,
      codexAdvisory,
      pr,
      checkpointId,
      questionId,
      worktreeReaped,
      worktreeReapError,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) await lease.release();
    // Drain the journal's serialized write queue (Journal has no other
    // open OS resource to release -- append() opens/closes its file handle
    // per write) before returning, on every path including early
    // returns/thrown errors, so a caller reading the journal right after
    // this function resolves never races an in-flight append.
    if (journal) await journal.close();
  }
}

// ---------------------------------------------------------------------------
// PR-ops reconcile
// ---------------------------------------------------------------------------

export interface PrOpsReconcileReport {
  /** prIntentIds where a PR genuinely exists (found via findPrForBranch) and pr_created was synthesized. */
  adopted: string[];
  /** prIntentIds where no PR was found -- surfaced for a human/operator to re-run `pros implement` or investigate. */
  needsManualRetry: string[];
  alreadyOk: string[];
}

/**
 * Scans every run directory under runsRoot for a `pr_create_intent` journal
 * entry with no matching `pr_created`, and tries to determine what actually
 * happened via `ghClient.findPrForBranch`. Called by `pros reconcile`.
 *
 * Does NOT auto-retry `gh pr create`: an idempotent "did this already run"
 * check is not reliably derivable from branch state alone if creation failed
 * before push-adjacent metadata existed -- so a not-found case is surfaced
 * for a human/operator rather than retried automatically.
 */
export async function reconcilePrOps(opts: {
  runsRoot: string;
  ghClient: GhClient;
  /** Caller supplies how to get a credential per repo, since different runs may target different repos. */
  credentialFor: (repo: string) => GhCredential;
}): Promise<PrOpsReconcileReport> {
  const report: PrOpsReconcileReport = { adopted: [], needsManualRetry: [], alreadyOk: [] };

  let runDirNames: string[];
  try {
    runDirNames = (await readdir(opts.runsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err: any) {
    if (err?.code === "ENOENT") return report;
    throw err;
  }

  for (const runId of runDirNames) {
    const runDir = path.join(opts.runsRoot, runId);
    if (!(await Journal.exists(runDir))) continue;

    const { entries } = await Journal.read(runDir);
    // Read as loosely-typed records -- pr_create_intent/pr_created are not
    // members of @pros/barrier's JournalEntry union (see file doc comment),
    // but unknown kinds pass through Journal/RunState untouched, so this is
    // safe and in keeping with house style (D12, tolerant parsing).
    const raw = entries as unknown as Array<Record<string, unknown>>;

    const intents = raw.filter((e) => e.kind === "pr_create_intent");
    const createdIntentIds = new Set(
      raw.filter((e) => e.kind === "pr_created").map((e) => e.prIntentId as string),
    );

    if (intents.length === 0) continue;

    const journal = await Journal.open(runDir);
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;

    for (const intent of intents) {
      const prIntentId = intent.prIntentId as string;
      const branch = intent.branch as string;
      const repo = intent.repo as string;

      if (createdIntentIds.has(prIntentId)) {
        report.alreadyOk.push(prIntentId);
        continue;
      }

      const cred = opts.credentialFor(repo);
      const found = await opts.ghClient.findPrForBranch(cred, repo, branch);

      if (found) {
        await journal.append({
          runId,
          fenceEpoch,
          kind: "pr_created",
          prIntentId,
          url: found.url,
          number: found.number,
          headSha: found.headSha,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        report.adopted.push(prIntentId);
      } else {
        report.needsManualRetry.push(prIntentId);
      }
    }
  }

  return report;
}
