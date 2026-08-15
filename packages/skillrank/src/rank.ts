import type { SkillCandidate, SkillProposal } from "./types.js";
import type { LocalSignals } from "./signals.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds the flat, deduped, lowercase set of "evidence tokens" from the
 * user's real local signals: bash verbs, tool names, and file extensions
 * (leading dot stripped, e.g. ".ts" -> "ts").
 */
function buildEvidenceTokens(signals: LocalSignals): Set<string> {
  const tokens = new Set<string>();
  for (const verb of signals.bashVerbs) {
    tokens.add(verb.toLowerCase());
  }
  for (const tool of signals.toolNames) {
    tokens.add(tool.toLowerCase());
  }
  for (const ext of signals.fileExtensions) {
    tokens.add(ext.toLowerCase().replace(/^\./, ""));
  }
  return tokens;
}

/**
 * A keyword matches if it case-insensitively appears as a substring of any
 * evidence token, or an evidence token appears as a substring of it (so
 * e.g. keyword "worktree" matches evidence token "worktree", and keyword
 * "git" matches evidence token "git-worktree" -- either direction).
 */
function keywordMatches(keyword: string, evidenceTokens: Set<string>): boolean {
  const kw = keyword.toLowerCase();
  for (const token of evidenceTokens) {
    if (token.length === 0) continue;
    if (token.includes(kw) || kw.includes(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Ranks catalog candidates against local signals. Score = count of the
 * candidate's keywords that match the user's real evidence (bash verbs +
 * tool names + file extensions). Candidates already installed (by slug)
 * are always excluded, never merely down-ranked. Only candidates with
 * score > 0 are included -- deliberately simple: there is no point
 * proposing a skill that matches nothing about this user's actual work.
 * Sorted descending by score, then alphabetically by slug for stable
 * ordering.
 */
export function rankProposals(catalog: SkillCandidate[], signals: LocalSignals): SkillProposal[] {
  const installed = new Set(signals.installedSlugs);
  const evidenceTokens = buildEvidenceTokens(signals);

  const proposals: SkillProposal[] = [];
  for (const candidate of catalog) {
    if (installed.has(candidate.slug)) {
      continue;
    }

    const matchedKeywords = candidate.keywords.filter((kw) => keywordMatches(kw, evidenceTokens));
    const score = matchedKeywords.length;
    if (score <= 0) {
      continue;
    }

    proposals.push({
      id: slugify(candidate.slug),
      slug: candidate.slug,
      name: candidate.name,
      reason: `Matches your recent tool/verb/file usage: ${matchedKeywords.join(", ")} (${score} signal${score === 1 ? "" : "s"})`,
      matchedKeywords,
      score,
      status: "proposed",
    });
  }

  proposals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slug.localeCompare(b.slug);
  });

  return proposals;
}
