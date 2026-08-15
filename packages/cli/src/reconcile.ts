import path from "node:path";
import { WorktreeAllocator, type ReconcileReport } from "@pros/worktree";
import { ConcurrencyLease } from "@pros/lease";
import { reconcilePrOps, type PrOpsReconcileReport } from "@pros/implement";
import { RealGhClient, loadCredentialFromEnv, type GhClient, type ScopedGhCredential } from "@pros/implement";

export interface ReconcileArgs {
  runsRoot: string;
  worktreesRoot: string;
  leaseDir: string;
  /** How old a lease's heartbeat must be before it's considered abandoned by a crashed run. */
  leaseStaleAfterMs: number;
}

export function parseReconcileArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ReconcileArgs {
  // pros reconcile [--stale-after=<ms>]
  const staleArg = argv.find((a) => a.startsWith("--stale-after="))?.slice("--stale-after=".length);
  const runsRoot = env.PROS_RUNS_DIR ?? path.join(env.HOME ?? "/root", ".pros", "runs");
  const worktreesRoot = env.PROS_WORKTREES_DIR ?? path.join(env.HOME ?? "/root", ".pros", "worktrees");
  const leaseDir = env.PROS_LEASE_DIR ?? path.join(env.HOME ?? "/root", ".pros", "leases");
  const leaseStaleAfterMs = staleArg ? Number(staleArg) : 60_000;
  return { runsRoot, worktreesRoot, leaseDir, leaseStaleAfterMs };
}

export interface ReconcileResult {
  worktrees: ReconcileReport;
  leasesFreed: string[];
  prOps: PrOpsReconcileReport | { skipped: string };
}

/**
 * `pros reconcile` -- the authoritative reaper (docs/00-decisions.md D9/D22).
 * Recovers whatever a crash left mid-flight:
 *   - worktree/branch allocations (via `@pros/worktree`'s `WorktreeAllocator.reconcile()`,
 *     which scans every run's journal under `runsRoot` and finishes or rolls
 *     back any non-terminal `worktree_*` saga -- `repoRoot` passed to the
 *     allocator's constructor is unused by `reconcile()` itself, which reads
 *     the real `repoRoot` back out of each allocation's own journal entry).
 *   - stale concurrency leases (via `@pros/lease`'s `ConcurrencyLease.reconcileStale()`),
 *     freeing capacity a crashed run never released.
 *   - in-flight PR ops (via `@pros/implement`'s `reconcilePrOps`): a
 *     `pr_create_intent` journal entry with no matching `pr_created` is
 *     looked up against the real `gh` state (`findPrForBranch`) and either
 *     adopted (the PR genuinely exists -- a crash happened only in recording
 *     that fact) or surfaced as `needsManualRetry` (no PR was found -- this
 *     is never auto-retried, since "did creation already run" isn't reliably
 *     derivable after the fact; a human/operator re-runs the implementation
 *     stage). Requires `PROS_GH_PR_TOKEN` to be set (same credential the
 *     Gate 2 pipeline itself uses, see `packages/implement/src/pr.ts`'s doc
 *     comment) -- if it isn't set, this step is skipped and reported as such
 *     rather than failing the whole `pros reconcile` invocation, since
 *     worktree/lease recovery must not be held hostage by an optional
 *     credential the operator hasn't provisioned yet.
 */
export async function runReconcile(args: ReconcileArgs, ghClient: GhClient = new RealGhClient()): Promise<ReconcileResult> {
  const allocator = new WorktreeAllocator({
    repoRoot: process.cwd(), // unused by reconcile() -- each allocation's own journal entry carries its real repoRoot
    worktreesRoot: args.worktreesRoot,
    runsRoot: args.runsRoot,
  });
  const worktrees = await allocator.reconcile();
  const { freed } = await ConcurrencyLease.reconcileStale(args.leaseDir, args.leaseStaleAfterMs);

  let prOps: ReconcileResult["prOps"];
  try {
    const credentials = new Map<string, ScopedGhCredential>();
    prOps = await reconcilePrOps({
      runsRoot: args.runsRoot,
      ghClient,
      credentialFor: (repo: string) => {
        let cred = credentials.get(repo);
        if (!cred) {
          cred = loadCredentialFromEnv(repo);
          credentials.set(repo, cred);
        }
        return cred;
      },
    });
  } catch (err) {
    // Most commonly: PROS_GH_PR_TOKEN is unset (loadCredentialFromEnv throws
    // lazily, the first time credentialFor() is actually called for some
    // repo -- if there are no pr_create_intent entries at all, this whole
    // try block never even calls credentialFor and succeeds trivially).
    prOps = { skipped: err instanceof Error ? err.message : String(err) };
  }

  return { worktrees, leasesFreed: freed, prOps };
}

export async function runReconcileCommand(argv: string[]): Promise<string> {
  const args = parseReconcileArgs(argv);
  const result = await runReconcile(args);
  const prOpsLine =
    "skipped" in result.prOps
      ? `pr ops: skipped (${result.prOps.skipped})`
      : `pr ops: ${result.prOps.adopted.length} adopted, ${result.prOps.needsManualRetry.length} need manual retry, ${result.prOps.alreadyOk.length} already ok`;
  const lines = [
    `worktrees: ${result.worktrees.finished.length} finished (adopted), ${result.worktrees.rolledBack.length} rolled back, ${result.worktrees.alreadyOk.length} already ok`,
    `leases: ${result.leasesFreed.length} stale lease(s) freed${result.leasesFreed.length ? ` (${result.leasesFreed.join(", ")})` : ""}`,
    prOpsLine,
  ];
  return lines.join("\n");
}
