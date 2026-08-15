import type { LoopCluster, SessionCard, StructuralTemplate } from "./types.js";

interface TemplateDef {
  label: string;
  verbs: string[];
  requiresSlot: boolean;
  slotAlternatives?: string[]; // used instead of the ticket/PR/URL slot regex for non-ticket templates
}

const SLOT_REGEX = /\b[A-Z]{2,}-\d+\b|\bpr\s*#?\d+\b|https?:\/\/\S+|\bticket\b/i;

export const TEMPLATES: TemplateDef[] = [
  {
    label: "ticket/error triage",
    verbs: ["triage", "investigate", "debug", "fix", "error", "bug", "broken", "failing", "incident"],
    requiresSlot: true,
  },
  {
    label: "pr review",
    verbs: ["review", "red team", "regression"],
    requiresSlot: false,
    slotAlternatives: ["pr", "pull request"],
  },
  {
    label: "deploy and verify",
    verbs: ["deploy", "ship", "release"],
    requiresSlot: false,
    slotAlternatives: ["beta", "verify", "prod"],
  },
];

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function matchTemplate(template: TemplateDef, openingPrompt: string): StructuralTemplate | undefined {
  const lower = openingPrompt.toLowerCase();
  const matchedVerbs = template.verbs.filter((v) => lower.includes(v.toLowerCase()));
  if (matchedVerbs.length === 0) {
    return undefined;
  }

  let hasTicketOrPrSlot = false;
  if (template.requiresSlot) {
    hasTicketOrPrSlot = SLOT_REGEX.test(openingPrompt);
    if (!hasTicketOrPrSlot) {
      return undefined;
    }
  } else if (template.slotAlternatives) {
    const slotMatch = template.slotAlternatives.some((alt) => lower.includes(alt.toLowerCase()));
    if (!slotMatch) {
      return undefined;
    }
    hasTicketOrPrSlot = SLOT_REGEX.test(openingPrompt);
  }

  return {
    label: template.label,
    verbs: matchedVerbs,
    hasTicketOrPrSlot,
  };
}

export function clusterSessions(cards: SessionCard[]): LoopCluster[] {
  const clusters: LoopCluster[] = [];

  for (const template of TEMPLATES) {
    const matchingSessionIds: string[] = [];
    const gatedSessionIds: string[] = [];
    let representativeTemplateMatch: StructuralTemplate | undefined;

    for (const card of cards) {
      const match = matchTemplate(template, card.openingPrompt);
      if (!match) {
        continue;
      }
      matchingSessionIds.push(card.sessionId);
      if (!representativeTemplateMatch) {
        representativeTemplateMatch = match;
      }
      if (card.hasPrLink || card.hasPlanArtifact) {
        gatedSessionIds.push(card.sessionId);
      }
    }

    if (matchingSessionIds.length >= 3 && gatedSessionIds.length >= 2 && representativeTemplateMatch) {
      clusters.push({
        id: slugify(template.label),
        label: template.label,
        sessionIds: matchingSessionIds,
        gatedSessionIds,
        template: representativeTemplateMatch,
      });
    }
  }

  clusters.sort((a, b) => {
    if (b.gatedSessionIds.length !== a.gatedSessionIds.length) {
      return b.gatedSessionIds.length - a.gatedSessionIds.length;
    }
    if (b.sessionIds.length !== a.sessionIds.length) {
      return b.sessionIds.length - a.sessionIds.length;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return clusters;
}
