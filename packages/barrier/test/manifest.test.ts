import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  computeWorkingStateHash,
  snapshotManifest,
  writeManifestAtomic,
  readManifest,
  writeManifestTempOnly,
  cleanupTemp,
} from "../src/manifest.js";
import { makeTempRepo, makeRunDir, cleanupDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("manifest: kill-test #7 - working-state hash changes for staged, unstaged, AND untracked files", async () => {
  const repo = await makeTempRepo();
  try {
    const base = await computeWorkingStateHash(repo);

    // Unstaged change to a tracked file.
    await appendFile(path.join(repo, "README.md"), "more\n");
    const afterUnstaged = await computeWorkingStateHash(repo);
    assert.notEqual(afterUnstaged, base, "unstaged tracked changes must move the hash");

    // Stage it.
    await execFileAsync("git", ["add", "."], { cwd: repo });
    const afterStaged = await computeWorkingStateHash(repo);
    assert.notEqual(afterStaged, afterUnstaged, "staging must move the hash even though `git diff` alone would go quiet");

    // Commit so tree is clean again, then add an untracked file only.
    await execFileAsync("git", ["commit", "-q", "-m", "wip"], { cwd: repo });
    const clean = await computeWorkingStateHash(repo);
    await writeFile(path.join(repo, "new-untracked-file.txt"), "half-written content");
    const afterUntracked = await computeWorkingStateHash(repo);
    assert.notEqual(
      afterUntracked,
      clean,
      "an untracked file must move the hash -- plain `git diff` would miss it entirely, which is exactly where a half-written new file hides",
    );

    // Changing the untracked file's content also moves the hash.
    await writeFile(path.join(repo, "new-untracked-file.txt"), "different content, same filename");
    const afterUntrackedEdit = await computeWorkingStateHash(repo);
    assert.notEqual(afterUntrackedEdit, afterUntracked);
  } finally {
    await cleanupDir(repo);
  }
});

test("manifest: snapshot writes an atomic, readable manifest.json", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const manifest = await snapshotManifest(runDir, {
      runId: "r1",
      cwd: repo,
      baseSha: "deadbeef",
      fenceEpoch: 0,
      launchConfig: { provider: "fixture", command: "true", args: [], cwd: repo },
    });
    const readBack = await readManifest(runDir);
    assert.deepEqual(readBack, manifest);
    assert.equal(readBack?.cwd, repo);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("manifest: kill-test #4 - crash between temp-write and rename leaves the previous manifest intact", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const first = await snapshotManifest(runDir, {
      runId: "r1",
      cwd: repo,
      baseSha: "aaa",
      fenceEpoch: 0,
      launchConfig: { provider: "fixture", command: "true", args: [], cwd: repo },
    });

    // Simulate a crash that only completed the temp-write, never the rename.
    const tmpPath = await writeManifestTempOnly(runDir, { ...first, headSha: "would-have-been-new" });

    const readBack = await readManifest(runDir);
    assert.deepEqual(readBack, first, "manifest.json must still be the last successfully-renamed version");

    const tmpContents = await readFile(tmpPath, "utf8");
    assert.ok(tmpContents.includes("would-have-been-new"));
    await cleanupTemp(tmpPath);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("manifest: writeManifestAtomic never leaves a torn manifest.json file on disk", async () => {
  const repo = await makeTempRepo();
  const runDir = await makeRunDir();
  try {
    const m1 = {
      runId: "r1",
      cwd: repo,
      cwdRealPath: repo,
      headSha: "a".repeat(40),
      baseSha: "a".repeat(40),
      workingStateHash: "x",
      fenceEpoch: 0,
      launchConfig: { provider: "fixture" as const, command: "true", args: [], cwd: repo },
      createdAt: new Date().toISOString(),
    };
    await writeManifestAtomic(runDir, m1);
    const m2 = { ...m1, workingStateHash: "y", fenceEpoch: 1 };
    await writeManifestAtomic(runDir, m2);
    const readBack = await readManifest(runDir);
    assert.deepEqual(readBack, m2);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});
