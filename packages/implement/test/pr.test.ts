import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadCredentialFromEnv,
  GhPermissionError,
  RealGhClient,
  LocalGhStub,
  type ScopedGhCredential,
  type PrHandle,
} from "../src/pr.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface Repo {
  bareRepoPath: string;
  workDir: string;
  featureBranch: string;
}

/** A real local bare repo + working clone with a `main` branch and a pushed feature branch. */
async function makeRepo(): Promise<Repo> {
  const bareRepoPath = await mkdtemp(path.join(tmpdir(), "pros-pr-test-origin-"));
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", bareRepoPath]);

  const workDir = await mkdtemp(path.join(tmpdir(), "pros-pr-test-work-"));
  await git(workDir, ["clone", "-q", bareRepoPath, "."]);
  await git(workDir, ["config", "user.email", "test@example.com"]);
  await git(workDir, ["config", "user.name", "Test"]);
  await writeFile(path.join(workDir, "README.md"), "hello\n");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-q", "-m", "init"]);
  await git(workDir, ["push", "-q", "origin", "main"]);

  const featureBranch = "feature/pr-test";
  await git(workDir, ["checkout", "-q", "-b", featureBranch]);
  await writeFile(path.join(workDir, "feature.txt"), "feature work\n");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-q", "-m", "feature commit"]);
  await git(workDir, ["push", "-q", "origin", featureBranch]);
  await git(workDir, ["checkout", "-q", "main"]);

  return { bareRepoPath, workDir, featureBranch };
}

async function cleanupRepo(repo: Repo): Promise<void> {
  await rm(repo.bareRepoPath, { recursive: true, force: true }).catch(() => undefined);
  await rm(repo.workDir, { recursive: true, force: true }).catch(() => undefined);
}

test("loadCredentialFromEnv throws when the token env var is unset, and never falls back", () => {
  assert.throws(() => loadCredentialFromEnv("acme/widgets", {}), /PROS_GH_PR_TOKEN/);
});

test("loadCredentialFromEnv parses scopes when both env vars are set", () => {
  const cred = loadCredentialFromEnv("acme/widgets", {
    PROS_GH_PR_TOKEN: "sekrit",
    PROS_GH_PR_SCOPES: "pull_requests:write,contents:read,metadata:read",
  });
  assert.equal(cred.token, "sekrit");
  assert.equal(cred.repo, "acme/widgets");
  assert.deepEqual(
    [...cred.scopes].sort(),
    ["contents:read", "metadata:read", "pull_requests:write"].sort(),
  );
});

test("create succeeds with pull_requests:write, and headSha matches the real branch tip", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const cred: ScopedGhCredential = {
      token: "stub-token",
      // Exactly the provisioning doc's recommended real-world scope set.
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const expectedSha = (await git(repo.bareRepoPath, ["rev-parse", repo.featureBranch])).trim();

    const pr = await stub.createDraftPr(cred, {
      cwd: repo.workDir,
      branch: repo.featureBranch,
      baseBranch: "main",
      title: "Test PR",
      body: "body",
    });

    assert.equal(pr.headSha, expectedSha);
    assert.match(pr.headSha, /^[0-9a-f]{40}$/);
    assert.equal(typeof pr.number, "number");
  } finally {
    await cleanupRepo(repo);
  }
});

test("CORE REQUIREMENT: merge fails closed for a credential missing contents:write, at the git data layer", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    // Same under-scoped credential as the create test above: contents:read, no contents:write.
    const cred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const pr = await stub.createDraftPr(cred, {
      cwd: repo.workDir,
      branch: repo.featureBranch,
      baseBranch: "main",
      title: "Test PR",
      body: "body",
    });

    const mainShaBefore = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();

    await assert.rejects(() => stub.mergePr(cred, pr), GhPermissionError);

    const mainShaAfter = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();
    assert.equal(mainShaAfter, mainShaBefore, "main must be completely unchanged -- the merge must not happen at all");
  } finally {
    await cleanupRepo(repo);
  }
});

test("CONTRAST: a credential with contents:write can actually merge, proving the rejection above is real", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const createCred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const pr = await stub.createDraftPr(createCred, {
      cwd: repo.workDir,
      branch: repo.featureBranch,
      baseBranch: "main",
      title: "Test PR",
      body: "body",
    });

    const mainShaBefore = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();

    // This is what a human's own admin-scoped token looks like -- never what
    // `pros` itself is given in the real pipeline.
    const humanAdminCred: ScopedGhCredential = {
      token: "human-admin-token",
      scopes: new Set(["pull_requests:write", "contents:write", "metadata:read"]),
      repo: "acme/widgets",
    };

    await stub.mergePr(humanAdminCred, pr);

    const mainShaAfter = (await git(repo.bareRepoPath, ["rev-parse", "main"])).trim();
    assert.notEqual(mainShaAfter, mainShaBefore, "main must actually move to reflect the merge");
  } finally {
    await cleanupRepo(repo);
  }
});

test("commentOnPr requires pull_requests:write", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const createCred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const pr = await stub.createDraftPr(createCred, {
      cwd: repo.workDir,
      branch: repo.featureBranch,
      baseBranch: "main",
      title: "Test PR",
      body: "body",
    });

    const noCommentCred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["contents:read"]),
      repo: "acme/widgets",
    };
    await assert.rejects(() => stub.commentOnPr(noCommentCred, pr, "hi"), GhPermissionError);

    // Succeeds with the right scope.
    await stub.commentOnPr(createCred, pr, "unresolved objection: waived, see review notes");
  } finally {
    await cleanupRepo(repo);
  }
});

test("findPrForBranch finds an existing PR for a branch", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const cred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const created = await stub.createDraftPr(cred, {
      cwd: repo.workDir,
      branch: repo.featureBranch,
      baseBranch: "main",
      title: "Test PR",
      body: "body",
    });

    const found = await stub.findPrForBranch(cred, "acme/widgets", repo.featureBranch);
    assert.ok(found, "expected findPrForBranch to find the PR");
    assert.equal(found!.number, created.number);
    assert.equal(found!.url, created.url);
    assert.equal(found!.headSha, created.headSha);
  } finally {
    await cleanupRepo(repo);
  }
});

test("findPrForBranch returns undefined when no PR exists for the branch", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const cred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
      repo: "acme/widgets",
    };

    const found = await stub.findPrForBranch(cred, "acme/widgets", "some/other-branch");
    assert.equal(found, undefined);
  } finally {
    await cleanupRepo(repo);
  }
});

test("findPrForBranch requires pull_requests:write", async () => {
  const repo = await makeRepo();
  try {
    const stub = new LocalGhStub({ bareRepoPath: repo.bareRepoPath });
    const noScopeCred: ScopedGhCredential = {
      token: "stub-token",
      scopes: new Set(["contents:read"]),
      repo: "acme/widgets",
    };
    await assert.rejects(() => stub.findPrForBranch(noScopeCred, "acme/widgets", repo.featureBranch), GhPermissionError);
  } finally {
    await cleanupRepo(repo);
  }
});

test("RealGhClient's scope pre-check fires before any subprocess/network call", async () => {
  const client = new RealGhClient();
  const underScopedCred: ScopedGhCredential = {
    token: "not-a-real-token",
    scopes: new Set(["pull_requests:write", "contents:read", "metadata:read"]),
    repo: "acme/does-not-exist",
  };
  // Deliberately nonsensical PR handle -- if the scope check did not run
  // first, this would fail with a `gh`-invocation error (or ENOENT if `gh`
  // isn't installed in this sandbox), not GhPermissionError.
  const bogusPr: PrHandle = { url: "file:///nonexistent/pull/999999", number: 999999, headSha: "0".repeat(40) };

  await assert.rejects(() => client.mergePr(underScopedCred, bogusPr), GhPermissionError);
});
