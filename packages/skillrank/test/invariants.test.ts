import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSkillrank, writeSkillrankOutput } from "../src/run.js";

const REAL_LOCK_FILE = path.join(process.cwd(), "..", "..", "skill-registry-lock.json");

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "skillrank-test-"));
}

test("runSkillrank + writeSkillrankOutput never modifies the lock file (byte-for-byte unchanged)", () => {
  const dir = tmpDir();
  const lockCopyPath = path.join(dir, "skill-registry-lock.json");

  // Copy the real repo-root lock file content into a tmp copy -- never
  // touch the real repo-root file from a test.
  const originalContent = readFileSync(REAL_LOCK_FILE, "utf8");
  writeFileSync(lockCopyPath, originalContent, "utf8");

  const minerOutDir = path.join(dir, "miner-out");
  const outDir = path.join(dir, "skillrank-out");

  const beforeHash = readFileSync(lockCopyPath, "utf8");
  const file = runSkillrank({ lockFilePath: lockCopyPath, minerOutDir, outDir });
  writeSkillrankOutput(file, outDir);
  const afterHash = readFileSync(lockCopyPath, "utf8");

  assert.equal(beforeHash, afterHash, "lock file copy must be byte-for-byte unchanged");
  assert.equal(originalContent, afterHash, "lock file copy must match original content exactly");

  rmSync(dir, { recursive: true, force: true });
});

test("writeSkillrankOutput only ever writes inside outDir (exactly one file: skill-proposals.json)", () => {
  const dir = tmpDir();
  const outDir = path.join(dir, "out");

  const file = runSkillrank({
    lockFilePath: path.join(dir, "nonexistent-lock.json"),
    minerOutDir: path.join(dir, "nonexistent-miner-out"),
    outDir,
  });
  writeSkillrankOutput(file, outDir);

  const entries = readdirSync(outDir);
  assert.deepEqual(entries, ["skill-proposals.json"]);

  // Confirm no sibling files were created outside outDir.
  const siblingEntries = readdirSync(dir).filter((e) => e !== "out");
  assert.deepEqual(siblingEntries, []);

  rmSync(dir, { recursive: true, force: true });
});
