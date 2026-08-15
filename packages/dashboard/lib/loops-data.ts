/**
 * Data-shaping helpers for the M6 "learning loop" page. Reads the
 * already-serialized proposals.json artifact written by @pros/miner --
 * this dashboard package must NOT depend on @pros/miner (it may be built
 * in parallel, possibly unfinished); it only ever reads a plain JSON file
 * off disk, exactly like lib/plan-doc.ts / lib/review-data.ts read
 * already-serialized state rather than importing a live pipeline.
 *
 * Product invariant (see the M6 brief): `status` on every proposal is
 * ALWAYS the literal string "proposed" -- there is no mechanism anywhere
 * that writes any other value. Proposals are surfaced for human review,
 * NEVER auto-applied. This module and the page built on top of it must
 * stay purely read-only and honest about that.
 */
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";

export interface LoopProposal {
  id: string;
  kind: "workflow" | "preference";
  name: string;
  evidenceSummary: string;
  sessionCount: number;
  gatedSessionCount: number;
  exampleQuotes: string[];
  status: "proposed";
}

export interface ProposalsFile {
  generatedAt: string;
  proposals: LoopProposal[];
}

/**
 * Mirrors lib/config.ts's getRunsRoot()/getIndexDbPath() pattern: env var
 * first, falling back to a `<HOME>/.pros/*` default. Unlike config.ts (which
 * intentionally matches the CLI's `HOME ?? "/root"` convention byte for
 * byte), the miner package this reads from has no prior CLI convention to
 * match, so os.homedir() is used per the brief.
 */
export function getMinerOutDir(): string {
  return process.env.PROS_MINER_OUT ?? path.join(os.homedir(), ".pros", "miner");
}

export interface LoadedProposals {
  available: boolean;
  generatedAt?: string;
  proposals: LoopProposal[];
}

/**
 * Reads `${minerOutDir}/proposals.json`. Never throws: missing file,
 * unparseable JSON, or a wrong-shaped top level all resolve to
 * `{ available: false, proposals: [] }` -- this page must render
 * gracefully before mining has ever been run (or if it fails), matching
 * this dashboard's "never look unhealthy, show the honest state"
 * convention and this project's tolerant-parsing house style (D12).
 * Individual malformed proposal entries are dropped rather than failing
 * the whole file.
 */
export function loadProposals(minerOutDir: string): LoadedProposals {
  const filePath = path.join(minerOutDir, "proposals.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { available: false, proposals: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, proposals: [] };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("proposals" in parsed) ||
    !Array.isArray((parsed as { proposals: unknown }).proposals)
  ) {
    return { available: false, proposals: [] };
  }

  const file = parsed as { generatedAt?: unknown; proposals: unknown[] };
  const proposals = file.proposals.map(coerceProposal).filter((p): p is LoopProposal => p !== undefined);

  return {
    available: true,
    generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : undefined,
    proposals,
  };
}

function coerceProposal(value: unknown): LoopProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return undefined;
  if (v.kind !== "workflow" && v.kind !== "preference") return undefined;
  if (typeof v.name !== "string") return undefined;
  if (typeof v.evidenceSummary !== "string") return undefined;
  if (typeof v.sessionCount !== "number") return undefined;
  if (typeof v.gatedSessionCount !== "number") return undefined;
  if (!Array.isArray(v.exampleQuotes) || !v.exampleQuotes.every((q) => typeof q === "string")) return undefined;
  // status is always "proposed" by product invariant (see file doc
  // comment) -- but validate rather than blindly trust the artifact.
  if (v.status !== "proposed") return undefined;

  return {
    id: v.id,
    kind: v.kind,
    name: v.name,
    evidenceSummary: v.evidenceSummary,
    sessionCount: v.sessionCount,
    gatedSessionCount: v.gatedSessionCount,
    exampleQuotes: v.exampleQuotes as string[],
    status: "proposed",
  };
}

export function groupProposalsByKind(proposals: LoopProposal[]): {
  workflows: LoopProposal[];
  preferences: LoopProposal[];
} {
  const workflows: LoopProposal[] = [];
  const preferences: LoopProposal[] = [];
  for (const p of proposals) {
    if (p.kind === "workflow") workflows.push(p);
    else preferences.push(p);
  }
  return { workflows, preferences };
}
