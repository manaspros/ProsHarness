import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Barrier, Journal } from "@pros/barrier";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { LocalGhStub, type GhClient, type PrHandle, type ScopedGhCredential, type DraftPrInput } from "../src/pr.js";
import { runGate2Pipeline, reconcilePrOps } from "../src/pipeline.js";
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

/** A real bare "origin" + a real working clone checked out onto a fresh feature branch, already pushed (empty) so `gh pr list`/create can see it. */
async function makeRepoScenario(branchName: string): Promise<RepoScenario> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-gate2-origin-"));
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", bareRepoPath]);

  const workDir = await mkdtemp(path.join(tmpdir(), "pros-gate2-work-"));
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

/**
 * Fake claude session serving BOTH the implement stage (commits a real file
 * + pushes, simulating what the real CLI + a separate push step would have
 * done) and the review stage's "ultrareview" pass, distinguished by
 * attemptId suffix -- exactly matching runGate2Pipeline's own attemptId
 * naming (`${runId}-implement`, `${attemptIdPrefix}-ultrareview`).
 */
class ClaudeStageSession {
  readonly provider = "claude" as const;
  constructor(
    private readonly worktreePath: string,
    private readonly ultrareviewObjections: unknown[] = [],
  ) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    if (opts.attemptId.endsWith("-implement")) {
      await writeFile(path.join(this.worktreePath, "fix.txt"), "fixed\n");
      await execFileAsync("git", ["add", "."], { cwd: this.worktreePath });
      await execFileAsync("git", ["commit", "-q", "-m", "apply fix"], { cwd: this.worktreePath });
      await execFileAsync("git", ["push", "-q", "origin", "HEAD"], { cwd: this.worktreePath });
      return { text: "Implemented the fix.", usage: { inputTokens: 50, outputTokens: 50 } };
    }
    if (opts.attemptId.endsWith("-ultrareview")) {
      return {
        text: JSON.stringify({ objections: this.ultrareviewObjections }),
        usage: { inputTokens: 20, outputTokens: 20 },
      };
    }
    throw new Error(`ClaudeStageSession: unexpected attemptId ${opts.attemptId}`);
  }
}

class CodexReviewSession {
  readonly provider = "codex" as const;
  constructor(private readonly objections: unknown[] = []) {}

  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ objections: this.objections }), usage: { inputTokens: 20, outputTokens: 20 } };
  }
}

class VerifierSession {
  readonly provider = "claude" as const;
  constructor(private readonly verdict: { outcome: "pass" | "fail"; summary: string; failingChecks: string[] }) {}

  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify(this.verdict), usage: { inputTokens: 15, outputTokens: 15 } };
  }
}

/** Wraps a GhClient and counts calls to createDraftPr, so tests can assert "PR creation never attempted". */
class CountingGhClient implements GhClient {
  createDraftPrCalls = 0;
  constructor(private readonly inner: GhClient) {}

  async createDraftPr(cred: ScopedGhCredential, input: DraftPrInput): Promise<PrHandle> {
    this.createDraftPrCalls++;
    return this.inner.createDraftPr(cred, input);
  }
  mergePr(cred: ScopedGhCredential, pr: PrHandle): Promise<void> {
    return this.inner.mergePr(cred, pr);
  }
  commentOnPr(cred: ScopedGhCredential, pr: PrHandle, body: string): Promise<void> {
    return this.inner.commentOnPr(cred, pr, body);
  }
  findPrForBranch(cred: ScopedGhCredential, repo: string, branch: string): Promise<PrHandle | undefined> {
    return this.inner.findPrForBranch(cred, repo, branch);
  }
}

const CRED: ScopedGhCredential = {
  token: "stub-token",
  scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
  repo: "acme/widgets",
};

async function makeRunDir(runId: string): Promise<{ runsRoot: string; runDir: string }> {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-gate2-runs-"));
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  return { runsRoot, runDir };
}

test("happy path: commit + pass verdict + clean review -> draft PR opens, parks for Gate 2, main is untouched", async () => {
  const runId = "run-happy-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  let server: Server | undefined;
  try {
    let resolveRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    server = createServer((_req, res) => {
      resolveRequest?.();
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const mainShaBefore = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();

    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));

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
      codexSession: new CodexReviewSession([]),
      verifierSession: new VerifierSession({ outcome: "pass", summary: "all checks pass", failingChecks: [] }),
      ghClient,
      ghCredential: CRED,
      // If Gate 2 wires notifications implicitly, this local endpoint
      // receives the request. It keeps the regression test fully offline.
      ntfyUrl: `http://127.0.0.1:${address.port}/test-notification`,
    });

    const notificationOutcome = await Promise.race([
      requestReceived.then(() => "sent" as const),
      new Promise<"not-sent">((resolve) => setTimeout(() => resolve("not-sent"), 100)),
    ]);
    assert.equal(notificationOutcome, "not-sent", "a library/test Gate 2 pipeline must not send without explicit opt-in");

    assert.ok(result.pr, "expected a draft PR to be opened");
    assert.ok(result.checkpointId, "expected a Gate 2 checkpointId");
    assert.ok(result.questionId, "expected a Gate 2 questionId");
    assert.equal(result.aborted, undefined);
    assert.equal(ghClient.createDraftPrCalls, 1);

    const barrier = await Barrier.open(runDir, runId);
    try {
      const state = barrier.getState();
      const cp = state.checkpoints.get(result.checkpointId!);
      assert.ok(cp, "checkpoint must exist in the journal");
      assert.equal(cp!.phase, "parked");
      assert.equal(cp!.gateType, "pr_review");
      assert.deepEqual(cp!.prRef, { url: result.pr!.url, number: result.pr!.number, headSha: result.pr!.headSha });
    } finally {
      await barrier.close();
    }

    const mainShaAfter = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();
    assert.equal(mainShaAfter, mainShaBefore, "the pipeline must never merge -- main must be completely unchanged");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("verification fails -> no PR, aborted at verify, gh client never called", async () => {
  const runId = "run-verify-fail-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));

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
      codexSession: new CodexReviewSession([]),
      verifierSession: new VerifierSession({ outcome: "fail", summary: "pnpm test: 2 failing", failingChecks: ["pnpm test: 2 failing"] }),
      ghClient,
      ghCredential: CRED,
    });

    assert.equal(result.pr, undefined);
    assert.ok(result.aborted);
    assert.equal(result.aborted!.stage, "verify");
    assert.equal(ghClient.createDraftPrCalls, 0, "PR creation must never be attempted after a failed verdict");
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("review finds a blocker -> no PR, aborted at review, gh client never called", async () => {
  const runId = "run-review-blocker-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));
    const blocker = { severity: "blocker", claim: "introduces a regression", suggested_change: "revert the change" };

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
      codexSession: new CodexReviewSession([blocker]),
      verifierSession: new VerifierSession({ outcome: "pass", summary: "all checks pass", failingChecks: [] }),
      ghClient,
      ghCredential: CRED,
    });

    assert.equal(result.pr, undefined);
    assert.ok(result.aborted);
    assert.equal(result.aborted!.stage, "review");
    assert.equal(ghClient.createDraftPrCalls, 0, "PR creation must never be attempted when a blocker is unresolved");
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("reconcilePrOps: adopts an intent whose PR actually exists, and synthesizes pr_created", async () => {
  const runId = "run-reconcile-adopt-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    // Simulate "the create actually succeeded before a simulated crash":
    // a real PR exists in the stub for this branch.
    const createdPr = await stub.createDraftPr(CRED, {
      cwd: repo.workDir,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      title: "t",
      body: "b",
    });

    const journal = await Journal.open(runDir);
    const prIntentId = "intent-adopt-1";
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "pr_create_intent",
      prIntentId,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      idempotencyKey: `pr-${runId}`,
      repo: CRED.repo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    const report = await reconcilePrOps({
      runsRoot,
      ghClient: stub,
      credentialFor: () => CRED,
    });

    assert.deepEqual(report.adopted, [prIntentId]);
    assert.deepEqual(report.needsManualRetry, []);

    const { entries } = await Journal.read(runDir);
    const raw = entries as unknown as Array<Record<string, unknown>>;
    const created = raw.find((e) => e.kind === "pr_created" && e.prIntentId === prIntentId);
    assert.ok(created, "expected a synthesized pr_created entry");
    assert.equal(created!.number, createdPr.number);
    assert.equal(created!.url, createdPr.url);
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("reconcilePrOps: reports needsManualRetry when no PR is found for the branch, and synthesizes nothing", async () => {
  const runId = "run-reconcile-retry-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    // Deliberately do NOT create any PR in the stub -- creation never
    // actually happened before the simulated crash.

    const journal = await Journal.open(runDir);
    const prIntentId = "intent-retry-1";
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "pr_create_intent",
      prIntentId,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      idempotencyKey: `pr-${runId}`,
      repo: CRED.repo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await journal.close();

    const report = await reconcilePrOps({
      runsRoot,
      ghClient: stub,
      credentialFor: () => CRED,
    });

    assert.deepEqual(report.needsManualRetry, [prIntentId]);
    assert.deepEqual(report.adopted, []);

    const { entries } = await Journal.read(runDir);
    const raw = entries as unknown as Array<Record<string, unknown>>;
    const created = raw.find((e) => e.kind === "pr_created");
    assert.equal(created, undefined, "no pr_created entry should be synthesized when no PR was found");
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M5: verdict/review durably journaled (not just returned in-memory)
// ---------------------------------------------------------------------------

test("happy path journals a verify_verdict (pass) and a review_completed (approve) entry", async () => {
  const runId = "run-journal-happy-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));

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
      codexSession: new CodexReviewSession([]),
      verifierSession: new VerifierSession({ outcome: "pass", summary: "all checks pass", failingChecks: [] }),
      ghClient,
      ghCredential: CRED,
    });

    assert.ok(result.pr, "expected a draft PR to be opened");

    const { entries } = await Journal.read(runDir);
    const raw = entries as unknown as Array<Record<string, unknown>>;

    const verdictEntry = raw.find((e) => e.kind === "verify_verdict");
    assert.ok(verdictEntry, "expected a durably journaled verify_verdict entry");
    assert.equal(verdictEntry!.outcome, "pass");
    assert.equal(verdictEntry!.summary, "all checks pass");
    assert.deepEqual(JSON.parse(verdictEntry!.failingChecksJson as string), []);

    const reviewEntry = raw.find((e) => e.kind === "review_completed");
    assert.ok(reviewEntry, "expected a durably journaled review_completed entry");
    assert.equal(reviewEntry!.verdict, "approve");
    assert.deepEqual(JSON.parse(reviewEntry!.unresolvedBlockersJson as string), []);
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("FAILING verification is durably journaled as verify_verdict(fail), not swallowed -- no review_completed follows", async () => {
  const runId = "run-journal-verify-fail-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));

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
      codexSession: new CodexReviewSession([]),
      verifierSession: new VerifierSession({
        outcome: "fail",
        summary: "pnpm test: 2 failing",
        failingChecks: ["pnpm test: 2 failing"],
      }),
      ghClient,
      ghCredential: CRED,
    });

    assert.equal(result.pr, undefined);
    assert.ok(result.aborted);
    assert.equal(result.aborted!.stage, "verify");

    // The whole point: a run that dropped a verification-failed event must
    // never look healthy -- the FAILING verdict must be recorded, not
    // swallowed, even though the pipeline aborted right after.
    const { entries } = await Journal.read(runDir);
    const raw = entries as unknown as Array<Record<string, unknown>>;

    const verdictEntry = raw.find((e) => e.kind === "verify_verdict");
    assert.ok(verdictEntry, "expected a durably journaled verify_verdict entry even on a failing run");
    assert.equal(verdictEntry!.outcome, "fail");
    assert.equal(verdictEntry!.summary, "pnpm test: 2 failing");
    assert.deepEqual(JSON.parse(verdictEntry!.failingChecksJson as string), ["pnpm test: 2 failing"]);

    // Review never runs after a failing verdict, so no review_completed
    // entry should exist for this run.
    const reviewEntry = raw.find((e) => e.kind === "review_completed");
    assert.equal(reviewEntry, undefined, "review stage never ran after a failing verdict -- no review_completed expected");
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("review with an unresolved blocker is durably journaled as review_completed(blockers-present)", async () => {
  const runId = "run-journal-review-blocker-1";
  const repo = await makeRepoScenario(`pros/${runId}/attempt`);
  const { runsRoot, runDir } = await makeRunDir(runId);
  try {
    const ghClient = new CountingGhClient(new LocalGhStub({ bareRepoPath: repo.bareRepoPath }));
    const blocker = { severity: "blocker", claim: "introduces a regression", suggested_change: "revert the change" };

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
      codexSession: new CodexReviewSession([blocker]),
      verifierSession: new VerifierSession({ outcome: "pass", summary: "all checks pass", failingChecks: [] }),
      ghClient,
      ghCredential: CRED,
    });

    assert.equal(result.pr, undefined);
    assert.ok(result.aborted);
    assert.equal(result.aborted!.stage, "review");

    const { entries } = await Journal.read(runDir);
    const raw = entries as unknown as Array<Record<string, unknown>>;

    const reviewEntry = raw.find((e) => e.kind === "review_completed");
    assert.ok(reviewEntry, "expected a durably journaled review_completed entry even when blockers abort the pipeline");
    assert.equal(reviewEntry!.verdict, "blockers-present");
    const unresolvedBlockers = JSON.parse(reviewEntry!.unresolvedBlockersJson as string);
    assert.equal(unresolvedBlockers.length, 1);
    assert.equal(unresolvedBlockers[0].claim, "introduces a regression");
  } finally {
    await cleanupRepoScenario(repo);
    await rm(runsRoot, { recursive: true, force: true });
  }
});
