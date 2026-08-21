/**
 * pr.ts -- draft-PR-via-`gh` module, and the merge-cannot-happen boundary.
 * ============================================================================
 *
 * WHAT THIS MODULE DOES
 * ----------------------------------------------------------------------------
 * Opens a draft PR from an already-pushed branch by shelling out to the real
 * `gh` CLI, using a scoped credential (`ScopedGhCredential`) that is
 * STRUCTURALLY incapable of merging -- not merely discouraged from merging by
 * convention, a wrapper script, or a prompt. Gate 2 of ProsHarness ("human
 * reviews & merges themselves, the system NEVER merges") depends on this
 * being a real, server-enforced boundary, because a wrapper is bypassable and
 * prompting an LLM not to do something is not a mechanism.
 *
 * THE CREDENTIAL BOUNDARY, PRECISELY (what a human operator must provision)
 * ----------------------------------------------------------------------------
 * For this mechanism to hold against REAL GitHub, provision a fine-grained
 * personal access token:
 *
 *   GitHub -> Settings -> Developer settings -> Fine-grained tokens
 *   - Repository access: ONLY this repository (not "all repositories")
 *   - Repository permissions:
 *       Pull requests : Read and write   (create/comment/label/close PRs)
 *       Contents      : Read-only        (NOT "Read and write")
 *       Metadata      : Read-only        (required minimum for any
 *                                          fine-grained token; has no
 *                                          higher setting)
 *
 * This is factual, documented GitHub API behavior, not an invented model:
 * GitHub's merge-PR endpoint (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`)
 * checks the token's "Contents" permission (the same permission that gates
 * `git push`), which is SEPARATE from the "Pull requests" permission that
 * gates PR creation/comments/reviews. A token scoped to
 * `pull_requests: write` + `contents: read` can open and manage a draft PR,
 * but GitHub's API itself will reject any attempt by that token to merge the
 * PR -- a 403 from GitHub's servers, not a client-side refusal this code
 * chose to add.
 *
 * Store the resulting token somewhere this module reads from explicitly (see
 * `ScopedGhCredential` / `loadCredentialFromEnv` below) -- e.g. the
 * `PROS_GH_PR_TOKEN` environment variable for this process only. NEVER reuse:
 *   - the operator's own `gh auth login` session (ambient `gh` credential
 *     store), or
 *   - a classic PAT with repo-wide `repo` scope,
 * because both of those CAN merge, which defeats the whole point.
 *
 * This module never calls a merge endpoint in its real pipeline path -- the
 * production Gate 2 flow only ever calls `createDraftPr` and `commentOnPr`.
 * `mergePr` exists on the `GhClient` interface and is implemented by
 * `RealGhClient` anyway (rather than being simply absent), specifically so
 * the credential-scope boundary is provable end-to-end by tests: the thing
 * that actually matters is that the TOKEN ITSELF cannot merge even if
 * something -- a bug, a compromised dependency, a future careless caller --
 * tried. That is exactly what `test/pr.test.ts`'s `LocalGhStub`-based tests
 * prove, by modeling GitHub's real documented permission split above in a
 * from-scratch local store and showing the merge path fails closed for an
 * under-scoped credential while succeeding for a genuinely capable one.
 *
 * WHAT THIS MODULE DOES NOT DO: `git push`
 * ----------------------------------------------------------------------------
 * Pushing the branch that a PR is opened against is a separate, already-solved
 * concern: per `docs/00-decisions.md` D1 (single-user/dogfood), the operator
 * pushes branches with their own normal git credentials on their own machine.
 * This module's scoped credential is used ONLY for `gh`/GitHub-API calls
 * (create PR, comment, request review, read PR state) -- it is never used
 * for, and has no code path that performs, `git push`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "@pros/barrier";

const execFileAsync = promisify(execFile);

export type GhScope =
  | "pull_requests:write"
  | "pull_requests:read"
  | "contents:write"
  | "contents:read"
  | "metadata:read";

export interface ScopedGhCredential {
  /** Never logged, never included in error messages or thrown Errors verbatim. */
  token: string;
  scopes: Set<GhScope>;
  /** e.g. "owner/repo" */
  repo: string;
}

/**
 * Reads the token from `env[tokenEnvVar]` (default "PROS_GH_PR_TOKEN") and
 * scopes from a comma-separated `env[scopesEnvVar]` (default
 * "PROS_GH_PR_SCOPES", e.g. "pull_requests:write,contents:read,metadata:read").
 * Throws a clear error if the token env var is unset -- this function never
 * silently falls back to any ambient/default `gh` credential.
 */
export function loadCredentialFromEnv(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { tokenEnvVar?: string; scopesEnvVar?: string },
): ScopedGhCredential {
  const tokenEnvVar = opts?.tokenEnvVar ?? "PROS_GH_PR_TOKEN";
  const scopesEnvVar = opts?.scopesEnvVar ?? "PROS_GH_PR_SCOPES";

  const token = env[tokenEnvVar];
  if (!token) {
    throw new Error(
      `Missing required environment variable "${tokenEnvVar}" -- refusing to fall back to any ` +
        `ambient "gh auth" session or default git credential. Provision a scoped fine-grained ` +
        `PAT (see the doc comment at the top of pr.ts) and set ${tokenEnvVar} explicitly.`,
    );
  }

  const rawScopes = env[scopesEnvVar] ?? "";
  const scopes = new Set(
    rawScopes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0) as GhScope[],
  );

  return { token, scopes, repo };
}

export class GhPermissionError extends Error {
  constructor(
    public readonly action: string,
    public readonly missingScope: GhScope,
  ) {
    super(`Action "${action}" requires scope "${missingScope}", which this credential does not have.`);
    this.name = "GhPermissionError";
  }
}

/**
 * The single place the scope check lives. Both `RealGhClient` and
 * `LocalGhStub` call this SAME function, against the SAME
 * `ScopedGhCredential.scopes` field, so that a test proving `LocalGhStub`
 * rejects an under-scoped credential is a real test of the shared
 * permission-check logic `RealGhClient` also runs -- not two independently
 * written checks that could silently drift apart.
 */
function requireScope(cred: ScopedGhCredential, scope: GhScope, action: string): void {
  if (!cred.scopes.has(scope)) {
    throw new GhPermissionError(action, scope);
  }
}

export interface DraftPrInput {
  cwd: string; // the worktree the branch lives in, for `gh pr create`'s repo context
  branch: string; // already pushed
  baseBranch: string; // e.g. "main"
  title: string;
  body: string; // should include unresolved review objections per the review skill's requirement
}

export interface PrHandle {
  url: string;
  number: number;
  headSha: string;
}

/**
 * Any credential a `GhClient` implementation can be driven with.
 * `RealGhClient`/`LocalGhStub` only ever receive a `ScopedGhCredential` in
 * practice (their scope checks require the `.scopes` field); `AmbientGhClient`
 * only ever receives an `AmbientGhCredential` (see the "AMBIENT PATH" doc
 * comment further down). The union lives on the shared `GhClient` interface
 * so callers that don't know which concrete client they hold (e.g.
 * `pipeline.ts`'s default-selection logic, `reconcile.ts`) can pass either.
 */
export type GhCredential = ScopedGhCredential | AmbientGhCredential;

export interface GhClient {
  /**
   * Requires "pull_requests:write" scope. Throws GhPermissionError if the
   * credential lacks it -- checked BEFORE shelling out/hitting the network,
   * so the check is meaningful even against a stub.
   */
  createDraftPr(cred: GhCredential, input: DraftPrInput): Promise<PrHandle>;

  /**
   * Requires "contents:write" scope (mirrors GitHub's real merge-endpoint
   * requirement). This method exists ONLY so the credential boundary is
   * provably real and testable -- the production Gate 2 pipeline (built by a
   * teammate in a follow-up pass) must never call it.
   */
  mergePr(cred: GhCredential, pr: PrHandle): Promise<void>;

  /**
   * Requires "pull_requests:write". Adds a comment (e.g. to surface
   * unresolved review objections that were waived rather than fixed).
   */
  commentOnPr(cred: GhCredential, pr: PrHandle, body: string): Promise<void>;

  /**
   * Requires "pull_requests:write". Looks up an existing PR for a branch, if
   * any -- used by reconcile to determine whether a crashed `createDraftPr`
   * call actually succeeded before the crash. Returns undefined if none
   * exists.
   */
  findPrForBranch(cred: GhCredential, repo: string, branch: string): Promise<PrHandle | undefined>;
}

/**
 * Shells out to the real `gh` CLI. `GH_TOKEN` is set ONLY from the passed
 * credential, for the duration of each call -- never `process.env.GH_TOKEN`,
 * never the user's default `gh auth` session. Ambient `GH_TOKEN` and
 * `GITHUB_TOKEN` are explicitly deleted from the child's environment before
 * the scoped token is added, so an ambient admin-scoped token lying around in
 * the operator's shell can never leak into a `gh` invocation this module
 * makes.
 *
 * Every method still performs the same pre-flight `cred.scopes.has(...)`
 * check as the `GhClient` interface doc requires, as defense in depth -- but
 * the REAL boundary this whole design rests on is that GitHub's own API
 * enforces the same check server-side regardless of what this code does,
 * which is exactly why it is safe to leave `mergePr()` implemented (rather
 * than simply absent) for real: even a compromised/modified copy of this
 * code cannot make an under-scoped real token merge anything.
 */
export class RealGhClient implements GhClient {
  private async execGh(args: string[], cwd: string, cred: ScopedGhCredential) {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    env.GH_TOKEN = cred.token;
    return execFileAsync("gh", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  }

  async createDraftPr(cred: ScopedGhCredential, input: DraftPrInput): Promise<PrHandle> {
    requireScope(cred, "pull_requests:write", "createDraftPr");

    const { stdout } = await this.execGh(
      [
        "pr",
        "create",
        "--draft",
        "--title",
        input.title,
        "--body",
        input.body,
        "--base",
        input.baseBranch,
        "--head",
        input.branch,
      ],
      input.cwd,
      cred,
    );

    const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
    const url = lines[lines.length - 1]?.trim();
    if (!url) {
      throw new Error(`Could not parse a PR URL out of \`gh pr create\` output: ${JSON.stringify(stdout)}`);
    }
    const match = url.match(/\/(\d+)\/?$/);
    if (!match) {
      throw new Error(`Could not parse a PR number out of \`gh pr create\` URL: ${url}`);
    }
    const number = Number(match[1]);

    const { stdout: shaOut } = await runGit(["rev-parse", input.branch], { cwd: input.cwd });
    const headSha = shaOut.trim();

    return { url, number, headSha };
  }

  async mergePr(cred: ScopedGhCredential, pr: PrHandle): Promise<void> {
    requireScope(cred, "contents:write", "mergePr");
    await this.execGh(["pr", "merge", String(pr.number), "--repo", cred.repo, "--squash"], process.cwd(), cred);
  }

  async commentOnPr(cred: ScopedGhCredential, pr: PrHandle, body: string): Promise<void> {
    requireScope(cred, "pull_requests:write", "commentOnPr");
    await this.execGh(
      ["pr", "comment", String(pr.number), "--repo", cred.repo, "--body", body],
      process.cwd(),
      cred,
    );
  }

  async findPrForBranch(cred: ScopedGhCredential, repo: string, branch: string): Promise<PrHandle | undefined> {
    requireScope(cred, "pull_requests:write", "findPrForBranch");

    let stdout: string;
    try {
      ({ stdout } = await this.execGh(
        ["pr", "list", "--repo", repo, "--head", branch, "--json", "url,number,headRefOid", "--state", "all"],
        process.cwd(),
        cred,
      ));
    } catch (err) {
      throw new Error(`findPrForBranch: \`gh pr list\` failed: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`findPrForBranch: could not parse \`gh pr list\` JSON output: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

    const first = parsed[0] as Record<string, unknown>;
    return {
      url: String(first.url),
      number: Number(first.number),
      headSha: String(first.headRefOid),
    };
  }
}

/**
 * AMBIENT PATH (zero-token default) -- read this alongside the module doc
 * comment above.
 * ----------------------------------------------------------------------------
 * `PROS_GH_PR_TOKEN` requires a human to provision a scoped fine-grained PAT
 * before Gate 2 can open a draft PR at all. That is the STRONGER path (see
 * above: GitHub's own server enforces the merge boundary, regardless of what
 * this code does), and it remains the default whenever it is configured.
 *
 * When it is NOT configured, `runGate2Pipeline` falls back to this ambient
 * path instead of requiring a token: `AmbientGhClient` shells out to the real
 * `gh` CLI using the ORCHESTRATOR's own ambient `gh auth login` session --
 * i.e. `process.env` completely unmodified, no `GH_TOKEN` override, nothing
 * stripped. This is safe to do here, and only here, because:
 *
 *   - The orchestrator (`pipeline.ts`) is deterministic TypeScript, never a
 *     model -- it is the process that legitimately owns the operator's
 *     ambient `gh` session, the same way a human running `gh pr create`
 *     themselves would.
 *   - Every MODEL/agent subprocess this project spawns (`scoped-fixer`,
 *     Codex, `claude ultrareview`, etc.) is stripped of `GH_TOKEN`/
 *     `GITHUB_TOKEN` and pointed at an empty `GH_CONFIG_DIR` before it ever
 *     starts, in `@pros/adapters`'s `spawnCli` -- so nothing a model
 *     subprocess does (including shelling out to `gh` itself via its own
 *     Bash tool) can ever reach this ambient session.
 *
 * RESIDUAL RISK vs the scoped-token path (be honest about this, don't paper
 * over it): the scoped-token path is safe even against a FULLY COMPROMISED
 * orchestrator, because GitHub's server -- not this code -- enforces the
 * merge boundary. The ambient path is NOT: it trusts the orchestrator's own
 * source. An agent capable of editing this repository's own source (e.g.
 * ProsHarness working on ProsHarness) could in principle widen its own reach
 * by editing `pipeline.ts`/`pr.ts` to call a merge method, and there is no
 * GitHub-server-side backstop catching that the way there is for an
 * under-scoped real token. The one cheap mitigation taken here: unlike
 * `RealGhClient.mergePr`/`LocalGhStub.mergePr` (which reject an under-scoped
 * credential via a scope check that a compromised orchestrator could in
 * principle edit away), `AmbientGhClient.mergePr` below performs NO scope
 * check at all and has NO code path that could ever invoke a real merge --
 * it is a single unconditional `throw`, present specifically so the refusal
 * is syntactically undeniable rather than a conditional an edit could flip.
 * That is a smaller guarantee than GitHub's real server-side enforcement,
 * and is deliberately documented as such rather than oversold.
 */

/**
 * The ambient path's credential is a pure repo-carrier -- there is no real
 * token or scope set to check (the orchestrator's ambient `gh auth` session
 * is used as-is, exactly like a human typing `gh pr create` themselves), so
 * `token`/`scopes` would be meaningless here. A distinct, minimal type keeps
 * that honest rather than stuffing fake values into `ScopedGhCredential`.
 */
export interface AmbientGhCredential {
  /** e.g. "owner/repo" */
  repo: string;
}

/**
 * Runs `gh auth status` to verify the orchestrator's ambient `gh` session is
 * actually logged in, BEFORE attempting any real `gh pr create`/etc call --
 * so a missing ambient session surfaces as one clear, actionable error
 * message instead of a confusing failure partway through PR creation.
 *
 * The actual exec call is injectable (`opts.exec`) specifically so tests
 * never need a real authenticated `gh` session on the machine running
 * them -- mirroring this project's house style of injecting `ModelSession`/
 * `GhClient` everywhere specifically so tests never depend on a real
 * external tool or account.
 */
export async function checkGhAuthenticated(opts?: {
  exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}): Promise<void> {
  const exec = opts?.exec ?? ((command: string, args: string[]) => execFileAsync(command, args));
  try {
    await exec("gh", ["auth", "status"]);
  } catch (err) {
    throw new Error(
      "gh is not authenticated -- run `gh auth login` first to use the zero-token ambient PR-creation path, " +
        "or set PROS_GH_PR_TOKEN to use a scoped token instead. " +
        `(underlying error: ${(err as Error).message})`,
    );
  }
}

/**
 * Shells out to the real `gh` CLI using the orchestrator process's own
 * ambient `process.env` completely unmodified -- deliberately NOT setting or
 * stripping `GH_TOKEN`/`GH_CONFIG_DIR` the way `RealGhClient.execGh` does,
 * because the whole point of this client is to use whatever `gh auth login`
 * session the operator already has on this machine, exactly as if they ran
 * `gh` themselves. See the module-level "AMBIENT PATH" doc comment above for
 * the full safety reasoning and residual-risk tradeoff.
 */
export class AmbientGhClient implements GhClient {
  private async execGh(args: string[], cwd: string) {
    return execFileAsync("gh", args, { cwd, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  }

  async createDraftPr(_cred: GhCredential, input: DraftPrInput): Promise<PrHandle> {
    const { stdout } = await this.execGh(
      [
        "pr",
        "create",
        "--draft",
        "--title",
        input.title,
        "--body",
        input.body,
        "--base",
        input.baseBranch,
        "--head",
        input.branch,
      ],
      input.cwd,
    );

    const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
    const url = lines[lines.length - 1]?.trim();
    if (!url) {
      throw new Error(`Could not parse a PR URL out of \`gh pr create\` output: ${JSON.stringify(stdout)}`);
    }
    const match = url.match(/\/(\d+)\/?$/);
    if (!match) {
      throw new Error(`Could not parse a PR number out of \`gh pr create\` URL: ${url}`);
    }
    const number = Number(match[1]);

    const { stdout: shaOut } = await runGit(["rev-parse", input.branch], { cwd: input.cwd });
    const headSha = shaOut.trim();

    return { url, number, headSha };
  }

  /**
   * Unconditional, categorical refusal -- no scope check, no flag, nothing
   * that could ever flip this to "allowed". This is the "cheap mitigation"
   * described in the module-level ambient-path doc comment: merging is
   * exclusively a human action via the GitHub UI or `gh` CLI run by the
   * human themselves, never automated, and this method's refusal is not
   * conditioned on anything a compromised orchestrator could edit around --
   * it is simply a throw, always.
   */
  async mergePr(_cred: GhCredential, _pr: PrHandle): Promise<void> {
    throw new Error(
      "AmbientGhClient refuses to merge -- merging is exclusively a human action via the GitHub UI or gh CLI, never automated",
    );
  }

  async commentOnPr(cred: GhCredential, pr: PrHandle, body: string): Promise<void> {
    await this.execGh(["pr", "comment", String(pr.number), "--repo", cred.repo, "--body", body], process.cwd());
  }

  async findPrForBranch(
    _cred: GhCredential,
    repo: string,
    branch: string,
  ): Promise<PrHandle | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await this.execGh(
        ["pr", "list", "--repo", repo, "--head", branch, "--json", "url,number,headRefOid", "--state", "all"],
        process.cwd(),
      ));
    } catch (err) {
      throw new Error(`findPrForBranch: \`gh pr list\` failed: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`findPrForBranch: could not parse \`gh pr list\` JSON output: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

    const first = parsed[0] as Record<string, unknown>;
    return {
      url: String(first.url),
      number: Number(first.number),
      headSha: String(first.headRefOid),
    };
  }
}

interface StubPrRecord {
  number: number;
  url: string;
  headSha: string;
  branch: string;
  baseBranch: string;
  merged: boolean;
  comments: string[];
}

/**
 * A from-scratch, in-memory model of a GitHub-like PR store, used ONLY by
 * this package's own tests. It is NOT a wrapper around the real `gh` binary
 * and it is NOT the security mechanism itself -- it exists to prove, without
 * touching real GitHub, that a credential lacking a scope is rejected
 * end-to-end by code that faithfully implements the same GhClient contract
 * RealGhClient does, including performing its permission checks against
 * the SAME ScopedGhCredential.scopes field RealGhClient reads (so a test
 * against this stub is a real test of the shared permission-check logic,
 * not of a mock that could pass vacuously). Backed by a real local bare git
 * repo (created via a temp dir + `git init --bare`) so branch/PR state is
 * genuinely git-shaped, not just an object literal.
 */
export class LocalGhStub implements GhClient {
  private readonly bareRepoPath: string;
  private readonly prs = new Map<number, StubPrRecord>();
  private nextNumber = 1;

  constructor(opts: { bareRepoPath: string }) {
    this.bareRepoPath = opts.bareRepoPath;
  }

  async createDraftPr(cred: ScopedGhCredential, input: DraftPrInput): Promise<PrHandle> {
    requireScope(cred, "pull_requests:write", "createDraftPr");

    const { stdout } = await execFileAsync("git", ["rev-parse", input.branch], { cwd: this.bareRepoPath });
    const headSha = stdout.trim();

    const number = this.nextNumber++;
    const url = `file://${this.bareRepoPath}/pull/${number}`;
    const record: StubPrRecord = {
      number,
      url,
      headSha,
      branch: input.branch,
      baseBranch: input.baseBranch,
      merged: false,
      comments: [],
    };
    this.prs.set(number, record);

    return { number, url, headSha };
  }

  async mergePr(cred: ScopedGhCredential, pr: PrHandle): Promise<void> {
    requireScope(cred, "contents:write", "mergePr");

    const record = this.prs.get(pr.number);
    if (!record) {
      throw new Error(`LocalGhStub: no such PR #${pr.number}`);
    }
    if (record.merged) {
      return;
    }

    // Perform a genuine merge against the bare repo: clone it to a scratch
    // working directory, merge the PR branch into baseBranch there, and push
    // the result back. This makes a "successful" stub merge actually show up
    // in the bare repo's git history, so the contrast with the rejected
    // (under-scoped) merge attempt is a real difference at the data layer,
    // not just a difference in which error object came back.
    const workDir = await mkdtemp(path.join(tmpdir(), "pros-pr-stub-merge-"));
    try {
      await execFileAsync("git", ["clone", "-q", this.bareRepoPath, workDir]);
      await execFileAsync("git", ["config", "user.email", "pros-stub@example.com"], { cwd: workDir });
      await execFileAsync("git", ["config", "user.name", "Pros LocalGhStub"], { cwd: workDir });
      await execFileAsync("git", ["checkout", "-q", record.baseBranch], { cwd: workDir });
      await execFileAsync(
        "git",
        ["merge", "--no-ff", "-q", "-m", `Merge PR #${record.number}`, `origin/${record.branch}`],
        { cwd: workDir },
      );
      await execFileAsync("git", ["push", "-q", "origin", record.baseBranch], { cwd: workDir });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }

    record.merged = true;
  }

  async commentOnPr(cred: ScopedGhCredential, pr: PrHandle, body: string): Promise<void> {
    requireScope(cred, "pull_requests:write", "commentOnPr");

    const record = this.prs.get(pr.number);
    if (!record) {
      throw new Error(`LocalGhStub: no such PR #${pr.number}`);
    }
    record.comments.push(body);
  }

  async findPrForBranch(cred: ScopedGhCredential, _repo: string, branch: string): Promise<PrHandle | undefined> {
    requireScope(cred, "pull_requests:write", "findPrForBranch");

    for (const record of this.prs.values()) {
      if (record.branch === branch) {
        return { url: record.url, number: record.number, headSha: record.headSha };
      }
    }
    return undefined;
  }
}
