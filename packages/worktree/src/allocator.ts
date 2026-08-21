/**
 * The worktree allocator (M2).
 *
 * See docs/03-architecture.md and docs/00-decisions.md D22: "the orchestrator
 * allocates" a uniquely named worktree, branch, and durable lease *before*
 * the agent starts, and passes the path in. Filesystem-plus-git is not
 * atomic, so allocation is built as a recoverable saga -- intent -> act ->
 * confirm -- durably recorded in the SAME per-run journal used by the
 * checkpoint barrier (`@pros/barrier`'s `Journal`). A crash at any point
 * leaves an unambiguous trail that `reconcile()` can replay and finish or
 * roll back later; it never has to guess.
 *
 * Saga steps, each an fsynced journal append (`Journal.append` fsyncs file +
 * dir before resolving), in order:
 *   1. intent   -- record the allocationId, chosen worktreePath and branch,
 *                  BEFORE any git command runs. If nothing after this ever
 *                  lands, reconcile knows a filesystem-level "act" was never
 *                  even attempted (or crashed with no trace) and can safely
 *                  roll back with nothing to clean up.
 *   2. act      -- `git worktree add -b <branch> <path> <baseRef>` from
 *                  repoRoot. Only on success do we append `worktree_allocated`.
 *                  If git throws, we deliberately do NOT append anything: the
 *                  bare intent is left for reconcile to classify next time.
 *   3. confirm  -- write a small atomic allocation record (temp-write +
 *                  rename + fsync, same pattern as barrier's
 *                  `writeManifestAtomic`) naming this allocation the run's
 *                  active worktree, then append `worktree_confirmed`.
 *
 * `reconcile()` is the authoritative recovery path (the `pros reconcile`
 * reaper from the architecture doc, scoped here to just the worktree saga).
 * It scans every run directory under `runsRoot`, replays each journal, and
 * for every allocationId that isn't already terminal (`worktree_confirmed`
 * or `worktree_rollback`) cross-checks the journal's story against real
 * git/filesystem state before deciding what to do. See `reconcile()` for the
 * exact classification rules and the design choice for the "act succeeded,
 * but the journal never recorded it" case.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, readdir, rm, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { Journal, loadRunState, git, runGit, type JournalEntry } from "@pros/barrier";

/** Branch/path name components must not carry slashes, spaces, etc. from a caller-supplied runId. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "-");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeAllocatorOptions {
  /** The git repository worktrees are allocated FROM. */
  repoRoot: string;
  /** Directory under which new worktree directories are created. */
  worktreesRoot: string;
  /** Directory under which each run gets its own subdirectory (journal.ndjson + allocation record). */
  runsRoot: string;
}

export interface WorktreeAllocation {
  allocationId: string;
  runId: string;
  path: string;
  branch: string;
  baseSha: string;
}

export interface AllocateOptions {
  /** Base ref to branch from. Defaults to HEAD. */
  baseRef?: string;
  /**
   * Test-only fault injection, mirroring `Journal.simulateIOFailureOnce()`:
   * abort the saga right after the named step completes durably, before the
   * next step runs -- simulating a process crash mid-saga so tests can drive
   * `reconcile()` against every crash point without racing a real kill -9.
   * Never set outside tests.
   */
  crashAfter?: "intent" | "act" | "allocated";
}

/** Thrown by `allocate()` when `crashAfter` fires. Test-only signal, not a real failure mode. */
export class AllocationCrashInjected extends Error {
  constructor(
    public readonly allocationId: string,
    public readonly stage: "intent" | "act" | "allocated",
  ) {
    super(`test-only crash injected after stage "${stage}" for allocation ${allocationId}`);
    this.name = "AllocationCrashInjected";
  }
}

export interface ReconcileReport {
  /** Allocations that were mid-flight with a real, valid git worktree on disk -- adopted (confirmed) rather than destroyed. */
  finished: string[];
  /** Allocations with no valid artifact (or an inconsistent/partial one) -- cleaned up and marked rolled back. */
  rolledBack: string[];
  /** Allocations already terminal (confirmed or rolled back) before this reconcile ran -- untouched. */
  alreadyOk: string[];
}

interface ActiveWorktreeRecord {
  allocationId: string;
  runId: string;
  path: string;
  branch: string;
  baseSha: string;
  confirmedAt: string;
}

/** Atomic temp-write + rename + fsync(file) + fsync(dir), same pattern as barrier's `writeManifestAtomic`. */
async function writeActiveWorktreeRecord(runDir: string, record: Omit<ActiveWorktreeRecord, "confirmedAt">): Promise<void> {
  const full: ActiveWorktreeRecord = { ...record, confirmedAt: new Date().toISOString() };
  const finalPath = path.join(runDir, "active-worktree.json");
  const tmpPath = path.join(runDir, `.active-worktree.json.tmp-${process.pid}-${Date.now()}`);

  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(JSON.stringify(full, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, finalPath);
  await Journal.fsyncDir(runDir);
}

interface GitWorktreeListEntry {
  path: string;
  branch?: string;
}

export class WorktreeAllocator {
  constructor(private readonly opts: WorktreeAllocatorOptions) {}

  private runDir(runId: string): string {
    return path.join(this.opts.runsRoot, runId);
  }

  async allocate(runId: string, opts: AllocateOptions = {}): Promise<WorktreeAllocation> {
    const allocationId = randomUUID();
    const branch = `pros/${sanitizeSegment(runId)}/${allocationId}`;
    const worktreePath = path.join(this.opts.worktreesRoot, `${sanitizeSegment(runId)}-${allocationId}`);
    const runDir = this.runDir(runId);
    const journal = await Journal.open(runDir);
    // Fence epoch is a monotonic property of the RUN (docs/03-architecture.md
    // "fencing, not just leases" -- every transition, MCP call, verdict and
    // PR op carries the current fence epoch). Worktree allocation is a run
    // transition too, so it must carry the run's real current epoch, not a
    // hardcoded 0 -- otherwise a stale-fence check downstream could never
    // distinguish an allocation from before vs. after an amendment/recovery
    // bump. Re-derived by replaying the journal, same as Barrier does.
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;

    // 1. Intent -- must be fsynced before any git command runs.
    await journal.append({
      runId,
      fenceEpoch,
      kind: "worktree_intent",
      allocationId,
      repoRoot: this.opts.repoRoot,
      worktreePath,
      branch,
    });
    if (opts.crashAfter === "intent") throw new AllocationCrashInjected(allocationId, "intent");

    // 2. Act -- if this throws, we deliberately append nothing: the bare
    // intent is left for reconcile to classify (see reconcile() below).
    await mkdir(this.opts.worktreesRoot, { recursive: true });
    await runGit(["worktree", "add", "-b", branch, worktreePath, opts.baseRef ?? "HEAD"], {
      cwd: this.opts.repoRoot,
    });
    if (opts.crashAfter === "act") throw new AllocationCrashInjected(allocationId, "act");

    const baseSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    await journal.append({
      runId,
      fenceEpoch,
      kind: "worktree_allocated",
      allocationId,
      baseSha,
      worktreePath,
      branch,
    });
    if (opts.crashAfter === "allocated") throw new AllocationCrashInjected(allocationId, "allocated");

    // 3. Confirm.
    await writeActiveWorktreeRecord(runDir, { allocationId, runId, path: worktreePath, branch, baseSha });
    await journal.append({ runId, fenceEpoch, kind: "worktree_confirmed", allocationId });

    return { allocationId, runId, path: worktreePath, branch, baseSha };
  }

  /** Parse `git worktree list --porcelain` in repoRoot into structured entries. */
  private async listGitWorktrees(repoRoot: string): Promise<GitWorktreeListEntry[]> {
    const stdout = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const entries: GitWorktreeListEntry[] = [];
    let current: Partial<GitWorktreeListEntry> = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) entries.push(current as GitWorktreeListEntry);
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "") {
        if (current.path) entries.push(current as GitWorktreeListEntry);
        current = {};
      }
    }
    if (current.path) entries.push(current as GitWorktreeListEntry);
    return entries;
  }

  private async findGitWorktree(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | undefined> {
    const entries = await this.listGitWorktrees(repoRoot);
    const resolved = await realpath(worktreePath).catch(() => worktreePath);
    return entries.find((e) => e.path === worktreePath || e.path === resolved);
  }

  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    try {
      await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  private async removeWorktreeForcibly(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      await runGit(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    } catch {
      // git lost track of this path entirely (e.g. a crash left a garbage
      // directory in its place rather than a real worktree link) -- prune
      // git's own bookkeeping and remove the directory by hand.
      await runGit(["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true });
    }
  }

  private async deleteBranch(repoRoot: string, branch: string): Promise<void> {
    await runGit(["branch", "-D", branch], { cwd: repoRoot }).catch(() => undefined);
  }

  /**
   * Scan every run directory under `runsRoot`, replay each journal, and
   * finish or roll back every non-terminal worktree allocation.
   *
   * Classification rules per allocationId (already-terminal entries --
   * `worktree_confirmed` or `worktree_rollback` -- are left untouched):
   *
   *   - No real git worktree AND no branch on disk (the common "intent only,
   *     act never ran or fully failed" case) -> nothing to clean up;
   *     append `worktree_rollback` so it is not reconsidered.
   *
   *   - A real, valid git worktree exists (directory present, `git worktree
   *     list` in repoRoot knows about it, AND the branch it reports matches
   *     the intent's branch, AND that branch ref exists) -> this is real,
   *     durable work. This covers BOTH "crashed after `git worktree add`
   *     succeeded but before `worktree_allocated` was appended" and "crashed
   *     after `worktree_allocated` but before `worktree_confirmed`" --
   *     DESIGN CHOICE: both are treated identically as "finish it" (adopt
   *     the mid-flight allocation), never destroy it. This matches the
   *     architecture doc's explicit rejection of the ownership split where
   *     a live worktree gets reported as an orphan. If `worktree_allocated`
   *     is itself missing, it is synthesized here so the journal's history
   *     stays complete before `worktree_confirmed` is appended.
   *
   *   - Anything else (directory exists but git doesn't know about it, or
   *     git knows about it but the directory is gone, or the branch it
   *     reports doesn't match, or the branch ref is missing/mismatched) is
   *     "partial/inconsistent disk state" -> roll back: forcibly remove the
   *     worktree (falling back to `git worktree prune` + manual `rm -rf` if
   *     git has lost track of it) and delete the orphan branch if present.
   *
   * Idempotency: once an allocationId reaches worktree_confirmed or
   * worktree_rollback, every subsequent reconcile() treats it as
   * already-ok and makes no further changes -- running reconcile() twice
   * in a row always produces an empty second report for anything the
   * first pass touched. No-double-allocation follows for free: every
   * allocationId gets its own worktreePath and branch name at intent time,
   * so two confirmed allocations can never collide on either.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { finished: [], rolledBack: [], alreadyOk: [] };

    let runDirNames: string[];
    try {
      runDirNames = (await readdir(this.opts.runsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err: any) {
      if (err?.code === "ENOENT") return report;
      throw err;
    }

    for (const runId of runDirNames) {
      const runDir = this.runDir(runId);
      if (!(await Journal.exists(runDir))) continue;

      const { entries } = await Journal.read(runDir);
      const byAllocation = new Map<string, JournalEntry[]>();
      for (const e of entries) {
        if (e.kind.startsWith("worktree_")) {
          const id = (e as { allocationId: string }).allocationId;
          const list = byAllocation.get(id);
          if (list) list.push(e);
          else byAllocation.set(id, [e]);
        }
      }

      const journal = await Journal.open(runDir);
      const currentFenceEpoch = (await loadRunState(runDir)).fenceEpoch;

      for (const [allocationId, group] of byAllocation) {
        const intent = group.find((e) => e.kind === "worktree_intent") as
          | Extract<JournalEntry, { kind: "worktree_intent" }>
          | undefined;
        if (!intent) continue; // no intent record -- nothing this reconcile pass can classify

        const allocated = group.find((e) => e.kind === "worktree_allocated") as
          | Extract<JournalEntry, { kind: "worktree_allocated" }>
          | undefined;
        const confirmed = group.some((e) => e.kind === "worktree_confirmed");
        const rolledBack = group.some((e) => e.kind === "worktree_rollback");

        if (confirmed || rolledBack) {
          report.alreadyOk.push(allocationId);
          continue;
        }

        const dirExists = await pathExists(intent.worktreePath);
        const gitEntry = await this.findGitWorktree(intent.repoRoot, intent.worktreePath);
        const hasBranch = await this.branchExists(intent.repoRoot, intent.branch);
        const validArtifact = dirExists && gitEntry !== undefined && hasBranch && gitEntry.branch === intent.branch;

        if (validArtifact) {
          let baseSha: string;
          if (allocated) {
            baseSha = allocated.baseSha;
          } else {
            baseSha = (await git(intent.worktreePath, ["rev-parse", "HEAD"])).trim();
            await journal.append({
              runId,
              fenceEpoch: currentFenceEpoch,
              kind: "worktree_allocated",
              allocationId,
              baseSha,
              worktreePath: intent.worktreePath,
              branch: intent.branch,
            });
          }
          await writeActiveWorktreeRecord(runDir, {
            allocationId,
            runId,
            path: intent.worktreePath,
            branch: intent.branch,
            baseSha,
          });
          await journal.append({ runId, fenceEpoch: currentFenceEpoch, kind: "worktree_confirmed", allocationId });
          report.finished.push(allocationId);
        } else {
          const reason =
            !dirExists && !gitEntry && !hasBranch
              ? "intent-only, no artifact"
              : "partial/inconsistent disk state: worktree or branch missing/corrupt";
          if (dirExists) await this.removeWorktreeForcibly(intent.repoRoot, intent.worktreePath);
          if (hasBranch) await this.deleteBranch(intent.repoRoot, intent.branch);
          await journal.append({ runId, fenceEpoch: currentFenceEpoch, kind: "worktree_rollback", allocationId, reason });
          report.rolledBack.push(allocationId);
        }
      }
    }

    return report;
  }
}
