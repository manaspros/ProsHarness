/**
 * pipeline.ts -- ties implement -> verify -> review -> draft PR -> parkForGate2
 * together (M4 Gate 2 pipeline), and the PR-ops reconcile helper `pros
 * reconcile` calls.
 *
 * Mirrors the shape of packages/plan/src/pipeline.ts's `runPlanPipeline`
 * closely: same Barrier.open/wireNtfyNotifications/close discipline, same
 * idempotent-park pattern, just calling `barrier.parkForGate2` instead of
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Barrier, Journal, loadRunState } from "@pros/barrier";
import { wireNtfyNotifications } from "@pros/notify";
import type { ModelSession } from "@pros/plan";
import { RealClaudeSession, RealCodexSession } from "@pros/plan";
import { ConcurrencyLease, TokenCeiling } from "@pros/lease";
import {
  type GhClient,
  type PrHandle,
  type ScopedGhCredential,
  RealGhClient,
  loadCredentialFromEnv,
} from "./pr.js";
import { runImplementation, type ImplementResult } from "./implement.js";
import { runVerification, type Verdict } from "./verify.js";
import { runAdversarialReview, type ReviewResult } from "./review.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

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
  /** Defaults to new RealClaudeSession(). */
  claudeSession?: ModelSession;
  /** Defaults to new RealCodexSession(). */
  codexSession?: ModelSession;
  /** Defaults to a SEPARATE new RealClaudeSession() instance -- never sharing a resumeSessionId with claudeSession. */
  verifierSession?: ModelSession;
  /** Defaults to new RealGhClient(). */
  ghClient?: GhClient;
  /** Defaults to loadCredentialFromEnv(<owner/repo derived from `git remote get-url origin`>). */
  ghCredential?: ScopedGhCredential;
  /** If given, acquire+heartbeat+release a ConcurrencyLease around the whole pipeline; if omitted, skip lease entirely. */
  leaseDir?: string;
  /** Required if leaseDir given. */
  maxConcurrent?: number;
  /** Shared across implement/verify/review stages. */
  tokenCeiling?: TokenCeiling;
  ntfyUrl?: string;
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
}

export interface Gate2PipelineResult {
  implementResult: ImplementResult;
  verdict: Verdict;
  review: ReviewResult;
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
    const claudeSession = opts.claudeSession ?? new RealClaudeSession();
    const codexSession = opts.codexSession ?? new RealCodexSession();
    const verifierSession = opts.verifierSession ?? new RealClaudeSession();
    const ghClient = opts.ghClient ?? new RealGhClient();

    const fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;

    const implementResult = await runImplementation({
      claudeSession,
      worktreePath: opts.worktreePath,
      branch: opts.branch,
      planMarkdown: opts.planMarkdown,
      fileAllowlist: opts.fileAllowlist,
      runId: opts.runId,
      attemptId: `${opts.runId}-implement`,
      repoRoot: opts.repoRoot,
      tokenCeiling: opts.tokenCeiling,
    });

    if (!implementResult.committed) {
      return {
        implementResult,
        verdict: { outcome: "fail", summary: "implementation produced no commit", failingChecks: [] },
        review: emptyReview(),
        aborted: { stage: "verify", reason: "implementation produced no commit" },
      };
    }

    const verdict = await runVerification({
      verifierSession,
      worktreePath: opts.worktreePath,
      runId: opts.runId,
      runDir: opts.runDir,
      expectedFenceEpoch: fenceEpoch,
      attemptId: `${opts.runId}-verify`,
      tokenCeiling: opts.tokenCeiling,
    });

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
      baseSha: implementResult.baseSha,
      headSha: implementResult.headSha,
      planMarkdown: opts.planMarkdown,
      runId: opts.runId,
      attemptIdPrefix: opts.runId,
      tokenCeiling: opts.tokenCeiling,
    });

    if (review.verdict === "blockers-present") {
      return {
        implementResult,
        verdict,
        review,
        aborted: { stage: "review", reason: `${review.unresolvedBlockers.length} unresolved blocker(s)` },
      };
    }

    // ---- Open the draft PR ----

    const cred = opts.ghCredential ?? loadCredentialFromEnv(await deriveRepoSlug(opts.worktreePath));

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

    const journal = await Journal.open(opts.runDir);
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
      const unsubscribe = wireNtfyNotifications(barrier, { url: opts.ntfyUrl });
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
      pr,
      checkpointId,
      questionId,
      worktreeReaped,
      worktreeReapError,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease) await lease.release();
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
  credentialFor: (repo: string) => ScopedGhCredential;
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
