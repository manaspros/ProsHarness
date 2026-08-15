import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKILL_CATALOG } from "./catalog.js";
import { gatherLocalSignals } from "./signals.js";
import { rankProposals } from "./rank.js";
import type { SkillProposalsFile } from "./types.js";

export interface RunSkillrankOptions {
  lockFilePath: string;
  minerOutDir: string;
  outDir: string;
}

/**
 * Computes a fresh SkillProposalsFile from local evidence. Purely offline
 * and read-only: reads skill-registry-lock.json and the miner's
 * history-vocabulary.json, never writes to either, never installs
 * anything, never hits a network registry.
 */
export function runSkillrank(opts: RunSkillrankOptions): SkillProposalsFile {
  const signals = gatherLocalSignals(opts.lockFilePath, opts.minerOutDir);
  const proposals = rankProposals(SKILL_CATALOG, signals);

  return {
    generatedAt: new Date().toISOString(),
    installedSlugs: signals.installedSlugs,
    proposals,
  };
}

/**
 * Writes skill-proposals.json to outDir. Must ONLY ever write inside
 * outDir -- never touches lockFilePath or minerOutDir.
 */
export function writeSkillrankOutput(file: SkillProposalsFile, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "skill-proposals.json"), JSON.stringify(file, null, 2), "utf8");
}
