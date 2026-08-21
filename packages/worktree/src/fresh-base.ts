/**
 * Fresh-base resolution: before a new session's workspace is created, decide
 * what "the latest state of the remote default branch" actually means for
 * this repo, right now.
 *
 * Root cause this exists for (see the operator's incident writeup): a
 * planning model cited a code site that turned out to be UNCOMMITTED
 * working-tree instrumentation in the operator's own checkout, not anything
 * on the candidate branch. `WorktreeAllocator.allocate()` (./allocator.ts)
 * already gives every run its own `git worktree add`, which does NOT copy
 * uncommitted changes -- but its default base ref is local `HEAD`, which:
 *   - can be a local branch that is behind the remote (stale truth), or
 *   - if a run's `repoRoot` were ever a working copy whose local `HEAD`
 *     itself carries local-only commits, would fold those into a "fresh"
 *     workspace and call it fresh.
 *
 * This module resolves a ref that is provably remote (`<remote>/<branch>`,
 * a remote-tracking ref that lives under `refs/remotes/`, never a local
 * branch) so `allocate()`'s `baseRef` option can be pointed at it instead of
 * `HEAD`. It never touches the parent repo's working tree or index -- it
 * only fetches and reads refs.
 *
 * Fetch-failure policy (deliberate, see docs on `resolveFreshBaseRef`):
 *   - fetch fails but a remote-tracking ref for the resolved default branch
 *     already exists on disk (e.g. from a previous fetch) -> proceed on that
 *     ref, but say so loudly (`fetchOk: false`, `usedStaleRemoteRef: true`,
 *     `detail` carries the fetch error). The caller journals this either way
 *     -- a run must never look "fresh" when it silently wasn't.
 *   - fetch fails AND no remote-tracking ref exists at all (fresh clone that
 *     never fetched, wrong credentials, missing remote) -> hard fail. There
 *     is no honest "fresh" answer to fall back to, and silently basing the
 *     workspace on local `HEAD` here is exactly the bug this module exists
 *     to close.
 */

import { git, runGit } from "@pros/barrier";

export interface ResolveFreshBaseRefOptions {
  /** The repo whose remote we fetch and whose refs we read. Never mutated beyond `git fetch`. */
  repoRoot: string;
  /** Git remote name (NOT a URL) -- defaults to "origin", the overwhelming convention. */
  remote?: string;
  /**
   * Caller-supplied last-resort default branch name (e.g. from a
   * `ProjectConfig`), used only if both `symbolic-ref` and `remote show`
   * detection fail. Never assumed -- omit to skip this fallback entirely.
   */
  defaultBranchFallback?: string;
  /** Test-only: skip the network `git fetch` and resolve purely from refs already on disk. */
  skipFetch?: boolean;
  /** Overrides the git timeout for the fetch call only (ms). */
  fetchTimeoutMs?: number;
}

export interface ResolveFreshBaseRefResult {
  remote: string;
  defaultBranch: string;
  /** A remote-tracking ref, e.g. "origin/main". Always of the form "<remote>/<defaultBranch>". */
  baseRef: string;
  /** Whether `git fetch` itself succeeded. */
  fetchOk: boolean;
  /** True when fetchOk is false but resolution still succeeded against a pre-existing (possibly stale) remote-tracking ref. */
  usedStaleRemoteRef: boolean;
  /** Human-readable detail (e.g. the fetch error) when fetchOk is false. Undefined on a clean fetch. */
  detail?: string;
}

/** Thrown when no honest "fresh" base ref can be produced -- see the fetch-failure policy above. Always carries the specific commands tried, not a generic message. */
export class FreshBaseResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshBaseResolutionError";
  }
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the remote's default branch name (NOT the ref, just e.g. "main").
 * Order, each only attempted if the previous one failed to produce an answer:
 *   1. `git symbolic-ref refs/remotes/<remote>/HEAD` -- sets locally by a
 *      real `git clone` or `git remote set-head <remote> --auto`.
 *   2. `git remote show <remote>` -- parses "HEAD branch: X" from its
 *      output. This itself talks to the network; if the fetch already
 *      failed this call may also fail, which is fine -- it just falls
 *      through to the next step.
 *   3. The caller-supplied `defaultBranchFallback` (e.g. a `ProjectConfig`
 *      field), if given.
 *   4. Whichever of "main"/"master" already exists as a remote-tracking ref
 *      on disk. Never assumes "main" outright -- this repo's own default is
 *      "master".
 * Throws `FreshBaseResolutionError` naming everything tried when all four fail.
 */
async function detectDefaultBranch(repoRoot: string, remote: string, fallback: string | undefined): Promise<string> {
  const attempts: string[] = [];

  try {
    const out = (await git(repoRoot, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])).trim();
    const prefix = `refs/remotes/${remote}/`;
    if (out.startsWith(prefix) && out.length > prefix.length) return out.slice(prefix.length);
    attempts.push(`symbolic-ref refs/remotes/${remote}/HEAD returned unexpected output: ${JSON.stringify(out)}`);
  } catch (err) {
    attempts.push(`symbolic-ref refs/remotes/${remote}/HEAD failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const out = await git(repoRoot, ["remote", "show", remote]);
    const match = out.match(/HEAD branch:\s*(\S+)/);
    if (match?.[1] && match[1] !== "(unknown)") return match[1];
    attempts.push(`remote show ${remote} did not report a resolvable HEAD branch`);
  } catch (err) {
    attempts.push(`remote show ${remote} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (fallback) return fallback;
  attempts.push("no defaultBranchFallback was supplied by the caller");

  for (const candidate of ["main", "master"]) {
    if (await refExists(repoRoot, `${remote}/${candidate}`)) return candidate;
  }
  attempts.push(`neither ${remote}/main nor ${remote}/master exist as remote-tracking refs`);

  throw new FreshBaseResolutionError(
    `could not detect the default branch for remote "${remote}" in ${repoRoot}:\n  - ${attempts.join("\n  - ")}`,
  );
}

/**
 * Fetches `remote` and resolves a provably remote-tracking base ref for a
 * new session's workspace. Never mutates the parent repo's working tree,
 * index, current branch, or local config -- only runs `git fetch` and
 * read-only ref queries.
 */
export async function resolveFreshBaseRef(opts: ResolveFreshBaseRefOptions): Promise<ResolveFreshBaseRefResult> {
  const remote = opts.remote ?? "origin";

  let fetchOk = true;
  let fetchDetail: string | undefined;
  if (!opts.skipFetch) {
    try {
      await runGit(["fetch", remote], { cwd: opts.repoRoot, timeoutMs: opts.fetchTimeoutMs });
    } catch (err) {
      fetchOk = false;
      fetchDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const defaultBranch = await detectDefaultBranch(opts.repoRoot, remote, opts.defaultBranchFallback);
  const baseRef = `${remote}/${defaultBranch}`;

  if (!(await refExists(opts.repoRoot, baseRef))) {
    throw new FreshBaseResolutionError(
      `cannot resolve a fresh base ref: "${baseRef}" does not exist as a remote-tracking ref in ${opts.repoRoot}` +
        (fetchOk
          ? " even though the fetch reported success -- the detected default branch name may be wrong"
          : ` and the fetch of remote "${remote}" also failed: ${fetchDetail}`),
    );
  }

  return {
    remote,
    defaultBranch,
    baseRef,
    fetchOk,
    usedStaleRemoteRef: !fetchOk,
    detail: fetchDetail,
  };
}
