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
import { runImplementation, type ImplementResult } from "./implement.js";
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
    const bodyLines = [
      `Automated Gate 2 pipeline for run \`${opts.runId}\`.`,
      "",
      `Verification: **${verdict.outcome}** -- ${verdict.summary}`,
      "",
    ];
    if (unresolvedNonBlockers.length > 0) {
      bodyLines.push(
        "Unresolved review objections (major/minor -- not blocking, but visible for the human reviewer):",
        "",
        ...unresolvedNonBlockers.map((o) => `- **[${o.severity}]** ${o.claim} -- suggested: ${o.suggested_change}`),
        "",
      );
    }
    const body = bodyLines.join("\n");
    const title = `[pros ${opts.runId}] automated implementation`;

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
