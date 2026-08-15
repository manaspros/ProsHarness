/**
 * Local evidence gathering, tolerant of absence. Never throws on a
 * missing/malformed file -- always resolves to an empty-but-well-shaped
 * result, matching this project's tolerant-parsing house style (see
 * packages/dashboard/lib/loops-data.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface LocalSignals {
  bashVerbs: string[];
  toolNames: string[];
  fileExtensions: string[];
  installedSlugs: string[];
}

interface LockFileSkillEntry {
  slug?: unknown;
}

interface LockFileShape {
  version?: unknown;
  skills?: unknown;
}

/**
 * Reads skill-registry-lock.json and returns the slugs already installed.
 * Tolerant: a missing file, unparseable JSON, or an unexpected shape all
 * resolve to [] rather than throwing. Individual malformed entries are
 * dropped rather than failing the whole read.
 */
export function readInstalledSlugs(lockFilePath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(lockFilePath, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  const file = parsed as LockFileShape;
  if (!Array.isArray(file.skills)) {
    return [];
  }

  const slugs: string[] = [];
  for (const entry of file.skills as LockFileSkillEntry[]) {
    if (typeof entry === "object" && entry !== null && typeof entry.slug === "string") {
      slugs.push(entry.slug);
    }
  }
  return slugs;
}

export interface HistoryVocabulary {
  bashVerbs: string[];
  toolNames: string[];
  fileExtensions: string[];
}

const EMPTY_VOCABULARY: HistoryVocabulary = { bashVerbs: [], toolNames: [], fileExtensions: [] };

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Reads `${minerOutDir}/history-vocabulary.json` (written by @pros/miner's
 * writeMiningOutput). This package deliberately does NOT import @pros/miner
 * -- it only reads the already-serialized JSON artifact, tolerant of the
 * miner never having run.
 */
export function readHistoryVocabulary(minerOutDir: string): HistoryVocabulary {
  const filePath = path.join(minerOutDir, "history-vocabulary.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { ...EMPTY_VOCABULARY };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_VOCABULARY };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ...EMPTY_VOCABULARY };
  }

  const file = parsed as Record<string, unknown>;
  return {
    bashVerbs: toStringArray(file.bashVerbs),
    toolNames: toStringArray(file.toolNames),
    fileExtensions: toStringArray(file.fileExtensions),
  };
}

export function gatherLocalSignals(lockFilePath: string, minerOutDir: string): LocalSignals {
  const installedSlugs = readInstalledSlugs(lockFilePath);
  const vocabulary = readHistoryVocabulary(minerOutDir);
  return {
    bashVerbs: vocabulary.bashVerbs,
    toolNames: vocabulary.toolNames,
    fileExtensions: vocabulary.fileExtensions,
    installedSlugs,
  };
}
