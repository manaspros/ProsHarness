import type { CorrectionHit, LoopCluster, LoopProposal, SessionCard } from "./types.js";

const MIN_CORRECTION_HITS_FOR_PREFERENCE = 5;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "…";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildLoopProposals(
  clusters: LoopCluster[],
  corrections: CorrectionHit[],
  cards: SessionCard[],
): LoopProposal[] {
  const cardById = new Map<string, SessionCard>();
  for (const card of cards) {
    cardById.set(card.sessionId, card);
  }

  const workflowProposals: LoopProposal[] = clusters.map((cluster) => {
    const exampleQuotes = cluster.sessionIds
      .slice(0, 3)
      .map((sessionId) => cardById.get(sessionId)?.openingPrompt ?? "")
      .map((prompt) => truncate(prompt, 140));

    return {
      id: `workflow-${cluster.id}`,
      kind: "workflow",
      name: `Recurring workflow: ${cluster.label}`,
      evidenceSummary: `${cluster.sessionIds.length} sessions matched this pattern, ${cluster.gatedSessionIds.length} with a linked PR or plan artifact.`,
      sessionCount: cluster.sessionIds.length,
      gatedSessionCount: cluster.gatedSessionIds.length,
      exampleQuotes,
      status: "proposed",
    };
  });

  workflowProposals.sort((a, b) => b.gatedSessionCount - a.gatedSessionCount);

  const hitsByCategory = new Map<string, CorrectionHit[]>();
  for (const hit of corrections) {
    const bucket = hitsByCategory.get(hit.category) ?? [];
    bucket.push(hit);
    hitsByCategory.set(hit.category, bucket);
  }

  const preferenceProposals: LoopProposal[] = [];
  for (const [category, hits] of hitsByCategory) {
    if (hits.length < MIN_CORRECTION_HITS_FOR_PREFERENCE) {
      continue;
    }
    const distinctSessionIds = new Set(hits.map((h) => h.sessionId));
    preferenceProposals.push({
      id: `preference-${slugify(category)}`,
      kind: "preference",
      name: `Preference: reduce "${category}" corrections`,
      evidenceSummary: `${hits.length} "${category}" correction(s) observed across ${distinctSessionIds.size} session(s).`,
      sessionCount: distinctSessionIds.size,
      gatedSessionCount: 0,
      exampleQuotes: hits.slice(0, 3).map((h) => h.quote),
      status: "proposed",
    });
  }

  preferenceProposals.sort((a, b) => b.sessionCount - a.sessionCount);

  return [...workflowProposals, ...preferenceProposals];
}
