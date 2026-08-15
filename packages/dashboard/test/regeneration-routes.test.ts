import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as regenerateLoops } from "../app/api/loops/regenerate/route.js";
import { POST as regenerateSkills } from "../app/api/skills/regenerate/route.js";
import { getOutputLockPath, withOutputLock } from "../lib/output-lock.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loops regeneration: runs locally, writes only the miner output, and returns counts without mined content", async () => {
  const root = await makeTempDir("pros-dashboard-miner-route-");
  const historyRoot = path.join(root, "claude");
  const outDir = path.join(root, "miner-out");
  try {
    await mkdir(path.join(historyRoot, "projects"), { recursive: true });
    await writeFile(path.join(historyRoot, "history.jsonl"), '{"display":"private prompt","timestamp":1}\n');

    const response = await withEnv(
      { PROS_CLAUDE_HOME: historyRoot, PROS_MINER_OUT: outDir },
      () => regenerateLoops(),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.proposalCount, 0);
    assert.equal(typeof body.generatedAt, "string");
    assert.equal("proposals" in body, false);
    assert.equal(await exists(path.join(outDir, "proposals.json")), true);
    assert.equal(await readFile(path.join(historyRoot, "history.jsonl"), "utf8"), '{"display":"private prompt","timestamp":1}\n');
    assert.equal(await exists(getOutputLockPath(outDir, "miner")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill regeneration: reads the configured repo lock and never changes it or installs anything", async () => {
  const root = await makeTempDir("pros-dashboard-skill-route-");
  const lockFile = path.join(root, "skill-registry-lock.json");
  const minerOutDir = path.join(root, "miner-out");
  const outDir = path.join(root, "skillrank-out");
  try {
    const lockContents = JSON.stringify({ version: 1, skills: [] });
    await writeFile(lockFile, lockContents);
    await mkdir(minerOutDir, { recursive: true });

    const response = await withEnv(
      { PROS_SKILL_LOCK_FILE: lockFile, PROS_MINER_OUT: minerOutDir, PROS_SKILLRANK_OUT: outDir },
      () => regenerateSkills(),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.proposalCount, 0);
    assert.equal("proposals" in body, false);
    assert.equal(await readFile(lockFile, "utf8"), lockContents);
    assert.equal(await exists(path.join(outDir, "skill-proposals.json")), true);
    assert.equal(await exists(getOutputLockPath(outDir, "skillrank")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("regeneration: an existing atomic lock returns a conflict and leaves the owner's lock intact", async () => {
  const root = await makeTempDir("pros-dashboard-conflict-");
  const minerOutDir = path.join(root, "miner-out");
  const skillrankOutDir = path.join(root, "skillrank-out");
  try {
    await mkdir(getOutputLockPath(minerOutDir, "miner"), { recursive: true });
    const minerResponse = await withEnv({ PROS_MINER_OUT: minerOutDir }, () => regenerateLoops());
    assert.equal(minerResponse.status, 409);
    assert.equal((await minerResponse.json()).ok, false);
    assert.equal(await exists(getOutputLockPath(minerOutDir, "miner")), true);

    await mkdir(getOutputLockPath(skillrankOutDir, "skillrank"), { recursive: true });
    const skillResponse = await withEnv({ PROS_SKILLRANK_OUT: skillrankOutDir }, () => regenerateSkills());
    assert.equal(skillResponse.status, 409);
    assert.equal((await skillResponse.json()).ok, false);
    assert.equal(await exists(getOutputLockPath(skillrankOutDir, "skillrank")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("regeneration: removes the lock when either package fails while writing output", async () => {
  const root = await makeTempDir("pros-dashboard-failure-");
  const minerOutDir = path.join(root, "miner-out");
  const skillrankOutDir = path.join(root, "skillrank-out");
  try {
    await mkdir(path.join(minerOutDir, "proposals.json"), { recursive: true });
    const minerResponse = await withEnv({ PROS_MINER_OUT: minerOutDir }, () => regenerateLoops());
    assert.equal(minerResponse.status, 500);
    assert.equal((await minerResponse.json()).ok, false);
    assert.equal(await exists(getOutputLockPath(minerOutDir, "miner")), false);

    await mkdir(path.join(skillrankOutDir, "skill-proposals.json"), { recursive: true });
    const skillResponse = await withEnv({ PROS_SKILLRANK_OUT: skillrankOutDir }, () => regenerateSkills());
    assert.equal(skillResponse.status, 500);
    assert.equal((await skillResponse.json()).ok, false);
    assert.equal(await exists(getOutputLockPath(skillrankOutDir, "skillrank")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output lock: cleanup runs when the protected callback throws", async () => {
  const outDir = await makeTempDir("pros-dashboard-lock-cleanup-");
  try {
    await assert.rejects(
      withOutputLock({
        outDir,
        operation: "test",
        run: () => {
          throw new Error("expected failure");
        },
      }),
      /expected failure/,
    );
    assert.equal(await exists(getOutputLockPath(outDir, "test")), false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
