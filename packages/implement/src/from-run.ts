/**
 * from-run.ts -- derives a `Gate2PipelineOptions` from a Gate-1-approved run
 * directory, so a caller only needs `{ runsRoot, runId }` instead of having
 * to hand-assemble every field the way `test/e2e-m4.test.ts` does manually.
 *
 * This is the ONE shared place both `pros implement <run-id>` (packages/cli/
 * src/implement.ts) and the Gate 1 -> Gate 2 continuation job (packages/
 * schedule/src/jobs.ts's `makeGate1ContinuationJob`) go through, so the two
 * call sites can never quietly drift on how a field is derived.
 *
 * ---- Field-by-field provenance ----
 *
 * `worktreePath` / `branch`: read straight off the run's `worktree_allocated`
 * journal entry (see packages/worktree/src/allocator.ts) -- note the FIELD
 * NAME on that entry is `worktreePath`, not `path` (the in-memory
 * `WorktreeAllocation` shape uses `path`; the durable journal entry does
 * not -- confirmed against the exact entry shape `runGate2Pipeline`'s own
 * e2e test reads back).
 *
 * `worktreeParentRepo` / `baseBranch`'s origin repo: the ORIGINATING repo
 * root (the one `runPlanPipeline` was called with as `repoRoot`, i.e. what
 * `git worktree add` branched from) turns out to already be durably
 * recorded -- `WorktreeAllocator.allocate()`'s very first saga step appends
 * a `worktree_intent` entry that carries `repoRoot: this.opts.repoRoot`
 * BEFORE any git command runs. So this is not actually a gap: this module
 * finds the `worktree_intent` entry matching the same `allocationId` as the
 * `worktree_allocated` entry above and reads `repoRoot` off THAT. No new
 * journal entry or on-disk record needed.
 *
 * `baseBranch`: derived by running `git rev-parse --abbrev-ref HEAD` in that
 * originating repo root (NOT in the worktree -- the worktree's HEAD is the
 * run's own feature branch, not the trunk it should be based against).
 *
 * `planMarkdown`: read straight from `<runDir>/plan.md`, written atomically
 * by `runPlanPipeline` (`writeFileAtomic`) at the end of Gate 1.
 *
 * `fileAllowlist`: NOT persisted anywhere as a flat list. Derived from the
 * approved plan's own structured content: find the `plan_finalized` entry
 * (carries `planId` + `version`), then find the ONE plan-content entry for
 * that exact `planId`+`version` -- `plan_drafted` if `version === 1` (the
 * first draft), `plan_revised` otherwise (a later revision produced by the
 * debate loop; see packages/plan/src/debate.ts) -- and parse its
 * `structuredJson` for a well-formed `.filesTouched: string[]`. If that
 * entry is missing, or `structuredJson` doesn't parse, or `filesTouched`
 * isn't a string array, this falls back to an EMPTY allowlist. That is not
 * a new invented behavior: `packages/implement/src/implement.ts` already
 * treats an empty `fileAllowlist` as "no restriction" (see its own doc
 * comments), so this fallback is exactly that existing, safe behavior.
 *
 * `repoRoot` (for loading `.claude/agents`/`.claude/skills` briefs): this is
 * NOT the originating target repo -- it's ProsHarness's own installation
 * root, exactly as `Gate2PipelineOptions`'s doc comment specifies. Callers
 * pass it in explicitly (mirroring packages/cli/src/schedule.ts's
 * `buildScheduledJobs`'s own `env.PROS_REPO_ROOT ?? process.cwd()`
 * convention) rather than this module trying to guess it.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { Journal, loadRunState, git } from "@pros/barrier";
import type { TokenCeiling } from "@pros/lease";
import type { Gate2PipelineOptions } from "./pipeline.js";

export interface DeriveGate2OptionsInput {
  runsRoot: string;
  runId: string;
  /** ProsHarness's own installation root -- NOT the target/originating repo. See Gate2PipelineOptions.repoRoot's doc comment. */
  repoRoot: string;
  leaseDir?: string;
  maxConcurrent?: number;
  tokenCeiling?: TokenCeiling;
  ntfyUrl?: string;
}

/**
 * Derives a full `Gate2PipelineOptions` from an approved Gate-1 run
 * directory. Throws a clear error if the run isn't far enough along to
 * derive Gate 2 options from (no worktree allocation, or no finalized
 * plan) -- callers should have already checked Gate 1 approval before
 * calling this (see packages/cli/src/implement.ts and packages/schedule/
 * src/jobs.ts's `makeGate1ContinuationJob` for that separate check).
 *
 * Does NOT set `reapWorktreeOnSuccess` -- that is a policy choice for the
 * caller (real orchestration call sites want `true`; some tests may not),
 * left explicit at each call site rather than defaulted here.
 */
export async function deriveGate2OptionsFromRun(opts: DeriveGate2OptionsInput): Promise<Gate2PipelineOptions> {
  const runDir = path.join(opts.runsRoot, opts.runId);
  const { entries } = await Journal.read(runDir);
  // Loosely-typed read, same tolerant-parsing technique pipeline.ts and
  // reconcilePrOps already use for ad-hoc journal kinds -- but here we're
  // reading kinds that ARE part of @pros/barrier's typed JournalEntry union
  // (worktree_*, plan_*), just narrowing by hand rather than via the
  // discriminated union's `Extract<>` (keeps this module decoupled from
  // needing @pros/worktree as a dependency just for its journal-entry
  // augmentations).
  const raw = entries as unknown as Array<Record<string, unknown>>;
  const latestClaudeSession = [...raw].reverse().find((e) => e.kind === "model_session_recorded" && e.provider === "claude") as
    | { dangerouslySkipPermissions?: boolean }
    | undefined;

  const allocatedEntry = raw.find((e) => e.kind === "worktree_allocated") as
    | { allocationId: string; worktreePath: string; branch: string }
    | undefined;
  if (!allocatedEntry) {
    throw new Error(
      `deriveGate2OptionsFromRun: no worktree_allocated journal entry found for run ${opts.runId} under ${runDir} -- Gate 1 never allocated a worktree for this run`,
    );
  }
  const worktreePath = allocatedEntry.worktreePath;
  const branch = allocatedEntry.branch;

  const intentEntry = raw.find(
    (e) => e.kind === "worktree_intent" && e.allocationId === allocatedEntry.allocationId,
  ) as { repoRoot: string } | undefined;
  if (!intentEntry) {
    throw new Error(
      `deriveGate2OptionsFromRun: no matching worktree_intent journal entry found for allocation ${allocatedEntry.allocationId} in run ${opts.runId} -- cannot determine the originating repo`,
    );
  }
  const worktreeParentRepo = intentEntry.repoRoot;

  // Checked before the `git rev-parse` call below (which requires a real,
  // reachable originating repo) so a run that never finished Gate 1's
  // debate fails with the actually-useful "no plan_finalized" message,
  // rather than a confusing lower-level git spawn error.
  const finalizedEntry = [...raw].reverse().find((e) => e.kind === "plan_finalized") as
    | { planId: string; version: number }
    | undefined;
  if (!finalizedEntry) {
    throw new Error(
      `deriveGate2OptionsFromRun: no plan_finalized journal entry found for run ${opts.runId} -- Gate 1's debate never completed for this run`,
    );
  }

  // `.trim()` at the call site, matching every other single-line `git rev-parse`
  // read in this codebase (implement.ts, allocator.ts, manifest.ts all do the
  // same) -- `git`/`runGit` (@pros/barrier) intentionally return raw stdout
  // unmodified since some callers (e.g. multi-line `git diff --name-only`)
  // need it untouched, so trimming is each single-line caller's own job.
  const baseBranch = (await git(worktreeParentRepo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  const planContentEntry = (
    finalizedEntry.version === 1
      ? [...raw].reverse().find(
          (e) => e.kind === "plan_drafted" && e.planId === finalizedEntry.planId && e.version === finalizedEntry.version,
        )
      : [...raw].reverse().find(
          (e) => e.kind === "plan_revised" && e.planId === finalizedEntry.planId && e.version === finalizedEntry.version,
        )
  ) as { structuredJson: string } | undefined;

  let fileAllowlist: string[] = [];
  if (planContentEntry) {
    try {
      const structured = JSON.parse(planContentEntry.structuredJson) as { filesTouched?: unknown };
      if (Array.isArray(structured.filesTouched) && structured.filesTouched.every((f) => typeof f === "string")) {
        fileAllowlist = structured.filesTouched as string[];
      }
    } catch {
      // Malformed structuredJson -- fall back to the empty allowlist below.
    }
  }

  const planMarkdown = await readFile(path.join(runDir, "plan.md"), "utf8");

  return {
    runId: opts.runId,
    runDir,
    worktreePath,
    branch,
    baseBranch,
    repoRoot: opts.repoRoot,
    planMarkdown,
    fileAllowlist,
    leaseDir: opts.leaseDir,
    maxConcurrent: opts.maxConcurrent,
    tokenCeiling: opts.tokenCeiling,
    ntfyUrl: opts.ntfyUrl,
    worktreeParentRepo,
    // Keep Gate 2 consistent with the always-on Claude Code session mode,
    // including runs created before this setting was made durable.
    dangerouslySkipPermissions: true,
  };
}

/**
 * Shared "has Gate 2 already been started (or completed) for this run"
 * check -- used by both `pros implement <run-id>` (to refuse a double-run
 * on manual invocation) and `makeGate1ContinuationJob` (to make each poll
 * tick idempotent: a run already picked up by a previous tick, or manually
 * via `pros implement`, must never be picked up again).
 *
 * A Gate 2 checkpoint (`gateType: "pr_review"`) is the clean signal, but a
 * crash between opening the PR-create intent and parking for Gate 2 would
 * leave no checkpoint yet -- so a `pr_create_intent`/`pr_created` journal
 * entry (see packages/implement/src/pipeline.ts's doc comment on why these
 * are ad-hoc kinds) counts too.
 */
export async function isGate2AlreadyStarted(runDir: string): Promise<boolean> {
  const state = await loadRunState(runDir);
  for (const cp of state.checkpoints.values()) {
    if (cp.gateType === "pr_review") return true;
  }
  const { entries } = await Journal.read(runDir);
  const raw = entries as unknown as Array<Record<string, unknown>>;
  return raw.some((e) => e.kind === "pr_create_intent" || e.kind === "pr_created");
}
