/**
 * Data-shaping helpers for the M7 "skillrank proposals" page. Reads the
 * already-serialized artifact written by @pros/skillrank's
 * `writeSkillrankOutput` -- this dashboard package must NOT depend on
 * @pros/skillrank, exactly mirroring lib/loops-data.ts's rationale: it
 * only ever reads a plain JSON file off disk.
 *
 * Product invariant (mirrors @pros/miner's LoopProposal / this package's
 * own SkillProposal): `status` on every proposal is ALWAYS the literal
 * string "proposed" -- nothing here (or anywhere) installs a skill
 * automatically. This is the "ranked suggestions, never auto-install"
 * feature the whole @pros/skillrank package exists for.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface SkillProposalRecord {
  id: string;
  slug: string;
  name: string;
  reason: string;
  matchedKeywords: string[];
  score: number;
  status: "proposed";
}

export function getSkillrankOutDir(): string {
  return process.env.PROS_SKILLRANK_OUT ?? path.join(os.homedir(), ".pros", "skillrank");
}

/**
 * Resolves the same repository lock file used by the skillrank CLI and
 * scheduler. Dashboard processes commonly start with packages/dashboard as
 * their cwd, so walk upward instead of assuming cwd is the workspace root.
 */
export function getSkillLockFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROS_SKILL_LOCK_FILE) return env.PROS_SKILL_LOCK_FILE;

  const start = path.resolve(env.PROS_REPO_ROOT ?? process.cwd());
  let current = start;
  while (true) {
    if (existsSync(path.join(current, "skill-registry-lock.json"))) {
      return path.join(current, "skill-registry-lock.json");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Preserve the CLI's predictable fallback when the lock file has not been
  // created yet; runSkillrank treats a missing lock as no installed skills.
  return path.join(start, "skill-registry-lock.json");
}

export interface LoadedSkillProposals {
  available: boolean;
  generatedAt?: string;
  installedSlugs: string[];
  proposals: SkillProposalRecord[];
}

function coerceProposal(value: unknown): SkillProposalRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return undefined;
  if (typeof v.slug !== "string") return undefined;
  if (typeof v.name !== "string") return undefined;
  if (typeof v.reason !== "string") return undefined;
  if (!Array.isArray(v.matchedKeywords) || !v.matchedKeywords.every((k) => typeof k === "string")) return undefined;
  if (typeof v.score !== "number") return undefined;
  if (v.status !== "proposed") return undefined;

  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    reason: v.reason,
    matchedKeywords: v.matchedKeywords as string[],
    score: v.score,
    status: "proposed",
  };
}

/**
 * Reads `${outDir}/skill-proposals.json`. Never throws: missing file,
 * unparseable JSON, or a wrong-shaped top level all resolve to
 * `{ available: false, installedSlugs: [], proposals: [] }` -- mirroring
 * lib/loops-data.ts's `loadProposals` exactly. Individual malformed
 * proposal entries are dropped rather than failing the whole file.
 */
export function loadSkillProposals(outDir: string): LoadedSkillProposals {
  const filePath = path.join(outDir, "skill-proposals.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { available: false, installedSlugs: [], proposals: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, installedSlugs: [], proposals: [] };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("proposals" in parsed) ||
    !Array.isArray((parsed as { proposals: unknown }).proposals)
  ) {
    return { available: false, installedSlugs: [], proposals: [] };
  }

  const file = parsed as { generatedAt?: unknown; installedSlugs?: unknown; proposals: unknown[] };
  const proposals = file.proposals.map(coerceProposal).filter((p): p is SkillProposalRecord => p !== undefined);
  const installedSlugs =
    Array.isArray(file.installedSlugs) && file.installedSlugs.every((s) => typeof s === "string")
      ? (file.installedSlugs as string[])
      : [];

  return {
    available: true,
    generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : undefined,
    installedSlugs,
    proposals,
  };
}
