/**
 * Types for the M7 "skillrank weekly proposals" feature.
 *
 * Product invariant (mirrors @pros/miner's LoopProposal exactly): `status`
 * on every proposal is ALWAYS the literal string "proposed" -- there is no
 * mechanism anywhere in this package that installs, promotes, or otherwise
 * acts on a proposal. This package NEVER touches skill-registry-lock.json,
 * NEVER installs anything, and NEVER hits a network registry. It only ever
 * reads local, already-serialized evidence and writes a ranked proposals
 * file for a human to review.
 */

export interface SkillCandidate {
  slug: string; // e.g. "obra/using-git-worktrees"
  name: string; // human-readable
  description: string;
  source: string; // URL, informational only, never fetched
  keywords: string[]; // lowercase keyword/verb/tool hints this skill is relevant for
}

export interface SkillProposal {
  id: string; // slugified from slug
  slug: string;
  name: string;
  reason: string; // evidence-grounded, e.g. "matches your frequent use of: git, worktree, parallel (12 sessions)"
  matchedKeywords: string[];
  score: number; // ranking score, higher = stronger match
  status: "proposed"; // literal, invariant: nothing ever changes this
}

export interface SkillProposalsFile {
  generatedAt: string;
  installedSlugs: string[]; // what was already in skill-registry-lock.json at generation time, for transparency
  proposals: SkillProposal[]; // ranked descending by score, EXCLUDES anything already installed
}
