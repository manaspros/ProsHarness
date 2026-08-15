export interface CorrectionHit {
  sessionId: string;
  project: string; // cwd/project path as recorded (raw, unmodified)
  timestampMs: number; // epoch ms
  quote: string; // the exact typed-prompt text this hit came from
  category: "revert" | "still-broken" | "no-wrong" | "i-told-you";
  lineIndex: number; // 0-based index of this line within history.jsonl
}

export interface SessionCard {
  sessionId: string;
  project: string;
  openingPrompt: string;
  toolCounts: Record<string, number>;
  bashVerbs: Record<string, number>;
  subagentTypes: string[]; // deduped, order of first appearance
  skillsInvoked: string[]; // deduped, order of first appearance
  filesWritten: string[]; // deduped
  hasPrLink: boolean;
  prUrls: string[];
  hasPlanArtifact: boolean;
  turnCount: number; // count of type:"user" rows in the session
}

export interface StructuralTemplate {
  label: string; // human-readable name, e.g. "ticket/error triage"
  verbs: string[]; // matched verb keywords found in the opening prompt
  hasTicketOrPrSlot: boolean; // whether a ticket-id/PR-number/URL-shaped token was found
}

export interface LoopCluster {
  id: string;
  label: string;
  sessionIds: string[];
  gatedSessionIds: string[]; // subset with hasPrLink or hasPlanArtifact true
  template: StructuralTemplate;
}

export interface LoopProposal {
  id: string;
  kind: "workflow" | "preference";
  name: string;
  evidenceSummary: string;
  sessionCount: number;
  gatedSessionCount: number;
  exampleQuotes: string[]; // for preference: correction quotes; for workflow: opening prompts (truncated to 140 chars)
  status: "proposed";
}
