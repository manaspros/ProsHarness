import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Barrier } from "@pros/barrier";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import {
  AmbientGhClient,
  checkGhAuthenticated,
  type GhClient,
  type GhCredential,
  type PrHandle,
  type DraftPrInput,
} from "../src/pr.js";
import { runGate2Pipeline } from "../src/pipeline.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface RepoScenario {
  bareRepoPath: string;
  workDir: string;
  branch: string;
  baseBranch: string;
}

async function makeRepoScenario(branchName: string): Promise<RepoScenario> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-ambient-origin-"));
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", bareRepoPath]);

  const workDir = await mkdtemp(path.join(tmpdir(), "pros-ambient-work-"));
  await git(workDir, ["clone", "-q", bareRepoPath, "."]);
  await git(workDir, ["config", "user.email", "test@example.com"]);
  await git(workDir, ["config", "user.name", "Test"]);
  await writeFile(path.join(workDir, "README.md"), "hello\n");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-q", "-m", "init"]);
  await git(workDir, ["push", "-q", "origin", "main"]);

  await git(workDir, ["checkout", "-q", "-b", branchName]);
  await git(workDir, ["push", "-q", "-u", "origin", branchName]);

  return { bareRepoPath, workDir, branch: branchName, baseBranch: "main" };
}

async function cleanupRepoScenario(s: RepoScenario): Promise<void> {
  await rm(s.bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  await rm(s.workDir, { recursive: true, force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// AmbientGhClient.mergePr: unconditional refusal, no scope, no flag, nothing
// flips it to "allowed" -- contrast with RealGhClient/LocalGhStub's tests
// (pr.test.ts), which prove rejection is SCOPE-CONDITIONAL. This proves the
// ambient client's refusal has no condition at all.
// ---------------------------------------------------------------------------

test("AmbientGhClient.mergePr always throws, unconditionally, for any input", async () => {
  const client = new AmbientGhClient();
  const anyPr: PrHandle = { url: "https://github.com/acme/widgets/pull/1", number: 1, headSha: "0".repeat(40) };
  const anyCred: GhCredential = { repo: "acme/widgets" };

  await assert.rejects(() => client.mergePr(anyCred, anyPr), /refuses to merge/);

  // Vary the input in every way we can think of -- number, repo, headSha --
  // to make the point that nothing about the input can make this succeed.
  await assert.rejects(
    () => client.mergePr({ repo: "someone-else/other-repo" }, { url: "x", number: 999999, headSha: "f".repeat(40) }),
    /refuses to merge/,
  );
});

// ---------------------------------------------------------------------------
// checkGhAuthenticated: both the "authenticated" and "not authenticated"
// paths, via the injectable exec seam -- never touches a real `gh` binary.
// ---------------------------------------------------------------------------

test("checkGhAuthenticated resolves silently when the injected exec succeeds", async () => {
  await checkGhAuthenticated({
    exec: async () => ({ stdout: "Logged in to github.com as someone", stderr: "" }),
  });
  // No throw = pass.
});

test("checkGhAuthenticated throws a clear, actionable error when the injected exec fails", async () => {
  await assert.rejects(
    () =>
      checkGhAuthenticated({
        exec: async () => {
          throw new Error("You are not logged into any GitHub hosts.");
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh is not authenticated/);
      assert.match(err.message, /gh auth login/);
      assert.match(err.message, /PROS_GH_PR_TOKEN/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Pipeline-level: runGate2Pipeline with no PROS_GH_PR_TOKEN and no explicit
// ghClient falls back to the ambient path and is actually reachable end to
// end, offline, via a from-scratch local stub mirroring LocalGhStub's
// pattern (real local bare git repo) but with NO scope-based permission
// checks -- matching AmbientGhClient's real behavior, including an
// unconditional mergePr refusal.
// ---------------------------------------------------------------------------

class LocalAmbientGhStub implements GhClient {
  private readonly bareRepoPath: string;
  private readonly prs = new Map<number, { number: number; url: string; headSha: string; branch: string; comments: string[] }>();
  private nextNumber = 1;

  constructor(opts: { bareRepoPath: string }) {
    this.bareRepoPath = opts.bareRepoPath;
  }

  async createDraftPr(_cred: GhCredential, input: DraftPrInput): Promise<PrHandle> {
    const { stdout } = await execFileAsync("git", ["rev-parse", input.branch], { cwd: this.bareRepoPath });
    const headSha = stdout.trim();
    const number = this.nextNumber++;
    const url = `file://${this.bareRepoPath}/pull/${number}`;
    this.prs.set(number, { number, url, headSha, branch: input.branch, comments: [] });
    return { number, url, headSha };
  }

  async mergePr(_cred: GhCredential, _pr: PrHandle): Promise<void> {
    // Mirrors AmbientGhClient's real, unconditional refusal exactly -- no
    // scope check to model here at all, since the ambient path has none.
    throw new Error(
      "LocalAmbientGhStub refuses to merge -- merging is exclusively a human action via the GitHub UI or gh CLI, never automated",
    );
  }

  async commentOnPr(_cred: GhCredential, pr: PrHandle, body: string): Promise<void> {
    const record = this.prs.get(pr.number);
    if (!record) throw new Error(`LocalAmbientGhStub: no such PR #${pr.number}`);
    record.comments.push(body);
  }

  async findPrForBranch(_cred: GhCredential, _repo: string, branch: string): Promise<PrHandle | undefined> {
    for (const record of this.prs.values()) {
      if (record.branch === branch) return { url: record.url, number: record.number, headSha: record.headSha };
    }
    return undefined;
  }
}

class ClaudeStageSession {
  readonly provider = "claude" as const;
  constructor(private readonly worktreePath: string) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    if (opts.attemptId.endsWith("-implement")) {
      await writeFile(path.join(this.worktreePath, "fix.txt"), "fixed\n");
      await execFileAsync("git", ["add", "."], { cwd: this.worktreePath });
      await execFileAsync("git", ["commit", "-q", "-m", "apply fix"], { cwd: this.worktreePath });
      await execFileAsync("git", ["push", "-q", "origin", "HEAD"], { cwd: this.worktreePath });
      return { text: "Implemented the fix.", usage: { inputTokens: 50, outputTokens: 50 } };
    }
    if (opts.attemptId.endsWith("-ultrareview")) {
      return { text: JSON.stringify({ objections: [] }), usage: { inputTokens: 20, outputTokens: 20 } };
    }
    throw new Error(`ClaudeStageSession: unexpected attemptId ${opts.attemptId}`);
  }
}

class CodexReviewSession {
  readonly provider = "codex" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ objections: [] }), usage: { inputTokens: 20, outputTokens: 20 } };
  }
}

/** Advisory-only post-Phase-3: outcome is derived from harness-run validationCommands (see the pipeline call below), not from this session's text. */
class VerifierSession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return {
      text: JSON.stringify({ summary: "all checks pass" }),
      usage: { inputTokens: 15, outputTokens: 15 },
    };
  }
}

async function makeRunDir(runId: string): Promise<{ runsRoot: string; runDir: string }> {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-ambient-runs-"));
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  return { runsRoot, runDir };
}

test("runGate2Pipeline falls back to the ambient path when PROS_GH_PR_TOKEN is unset and no ghClient override is given", async () => {
  const runId = "run-ambient-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  const prevToken = process.env.PROS_GH_PR_TOKEN;
  try {
    delete process.env.PROS_GH_PR_TOKEN;

    const ghClient = new LocalAmbientGhStub({ bareRepoPath: repo.bareRepoPath });

    // Deliberately do NOT pass ghCredential either -- the pipeline must
    // derive an AmbientGhCredential ({ repo }) on its own from the git
    // remote, exactly mirroring the scoped-token path's own
    // deriveRepoSlug-based default.
    const result = await runGate2Pipeline({
      runId,
      runDir,
      worktreePath: repo.workDir,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      repoRoot: REPO_ROOT,
      planMarkdown: "# Plan\nFix the thing.",
      fileAllowlist: ["fix.txt"],
      claudeSession: new ClaudeStageSession(repo.workDir),
      codexSession: new CodexReviewSession(),
      verifierSession: new VerifierSession(),
      validationCommands: [{ command: "exit 0", label: "checks" }],
      ghClient,
    });

    assert.ok(result.pr, "expected a draft PR to be opened via the ambient path");
    assert.ok(result.checkpointId, "expected a Gate 2 checkpointId");
    assert.equal(result.aborted, undefined);

    const barrier = await Barrier.open(runDir, runId);
    try {
      const state = barrier.getState();
      const cp = state.checkpoints.get(result.checkpointId!);
      assert.ok(cp, "checkpoint must exist in the journal");
      assert.equal(cp!.phase, "parked");
    } finally {
      await barrier.close();
    }
  } finally {
    if (prevToken === undefined) delete process.env.PROS_GH_PR_TOKEN;
    else process.env.PROS_GH_PR_TOKEN = prevToken;
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});
