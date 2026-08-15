import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { rankHunks } from "../src/hunks.js";
import { makeFixtureRepo } from "./helpers.js";

test("rankHunks: sorted descending by riskScore, lockfile collapsed+bottom, auth+throw ranks highest, untested file flagged", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const result = rankHunks({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });

    assert.equal(result.totalFiles, 4, "auth.ts, package-lock.json, untested.ts, net.ts touched -- expect 4 files with hunks");
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("rankHunks: full ordering/collapsing/riskFactors assertions", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const result = rankHunks({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });

    // Sorted descending by riskScore.
    for (let i = 1; i < result.hunks.length; i++) {
      assert.ok(
        result.hunks[i - 1]!.riskScore >= result.hunks[i]!.riskScore,
        `expected hunks sorted descending by riskScore: ${result.hunks[i - 1]!.file}(${result.hunks[i - 1]!.riskScore}) >= ${result.hunks[i]!.file}(${result.hunks[i]!.riskScore})`,
      );
    }

    const lockfileHunk = result.hunks.find((h) => h.file === "package-lock.json");
    assert.ok(lockfileHunk, "expected a hunk for package-lock.json");
    assert.equal(lockfileHunk!.collapsedByDefault, true);
    const lockfileIndex = result.hunks.indexOf(lockfileHunk!);
    assert.equal(lockfileIndex, result.hunks.length - 1, "lockfile hunk must rank at the bottom");

    const authHunk = result.hunks.find((h) => h.file === "packages/foo/src/auth.ts");
    assert.ok(authHunk, "expected a hunk for auth.ts");
    assert.equal(result.hunks[0], authHunk, "the auth+throw hunk must rank highest");
    assert.ok(
      authHunk!.riskFactors.some((f) => f.includes("touches keyword: auth")),
      `expected auth keyword risk factor, got: ${JSON.stringify(authHunk!.riskFactors)}`,
    );

    const untestedHunk = result.hunks.find((h) => h.file === "packages/foo/src/untested.ts");
    assert.ok(untestedHunk, "expected a hunk for untested.ts");
    assert.ok(
      untestedHunk!.riskFactors.includes("no apparent test coverage"),
      `expected no-test-coverage risk factor, got: ${JSON.stringify(untestedHunk!.riskFactors)}`,
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("rankHunks: determinism -- identical inputs produce deep-equal output across two calls", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const first = rankHunks({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    const second = rankHunks({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    assert.deepEqual(first, second);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("rankHunks: verificationFailingChecks and reviewObjections bump the cited file's risk score", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const withoutBumps = rankHunks({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
    const netBefore = withoutBumps.hunks.find((h) => h.file === "packages/foo/src/net.ts")!;

    const withBumps = rankHunks({
      repoRoot: fixture.repoRoot,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      verificationFailingChecks: ["packages/foo/src/net.ts: pnpm test failed"],
      reviewObjections: [{ severity: "blocker", claim: "packages/foo/src/net.ts makes an unvalidated network call" }],
    });
    const netAfter = withBumps.hunks.find((h) => h.file === "packages/foo/src/net.ts")!;

    assert.ok(netAfter.riskScore > netBefore.riskScore);
    assert.ok(netAfter.riskFactors.includes("verification flagged this file"));
    assert.ok(netAfter.riskFactors.includes("reviewer raised a concern citing this file"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
