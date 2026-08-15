import os from "node:os";
import path from "node:path";
import { runSkillrank, writeSkillrankOutput } from "../src/run.js";

/**
 * lockFilePath resolution: PROS_SKILL_LOCK_FILE env var if set, else
 * `${cwd}/skill-registry-lock.json`. This CLI must therefore be run from
 * the repo root (where skill-registry-lock.json lives) unless
 * PROS_SKILL_LOCK_FILE is set explicitly -- documented here rather than
 * doing directory-walking discovery, to keep behavior simple/predictable.
 */
function resolveLockFilePath(): string {
  const fromEnv = process.env.PROS_SKILL_LOCK_FILE;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(process.cwd(), "skill-registry-lock.json");
}

function resolveMinerOutDir(): string {
  const fromEnv = process.env.PROS_MINER_OUT;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".pros", "miner");
}

function resolveOutDir(): string {
  const fromEnv = process.env.PROS_SKILLRANK_OUT;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".pros", "skillrank");
}

const lockFilePath = resolveLockFilePath();
const minerOutDir = resolveMinerOutDir();
const outDir = resolveOutDir();

const file = runSkillrank({ lockFilePath, minerOutDir, outDir });
writeSkillrankOutput(file, outDir);

// Counts and paths only -- never print proposal content (name/reason/etc)
// to stdout, to keep this quiet/observable-by-file rather than noisy.
console.log(
  `skillrank: ${file.proposals.length} proposal(s) from ${lockFilePath} + ${minerOutDir} -> ${path.join(outDir, "skill-proposals.json")}`,
);
