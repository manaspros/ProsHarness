import path from "node:path";
import { listSessionTranscriptFiles, readHistoryLines, readSessionTranscript } from "./history-source.js";
import type { SessionCard } from "./types.js";

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
        texts.push((block as any).text);
      }
    }
    return texts.join("");
  }
  return "";
}

function firstToken(command: string): string {
  const trimmed = command.trimStart();
  const match = trimmed.match(/^\S+/);
  return match ? match[0] : "";
}

interface MutableCard {
  sessionId: string;
  project: string;
  cwdFallback: string;
  openingPrompt: string | undefined;
  toolCounts: Record<string, number>;
  bashVerbs: Record<string, number>;
  subagentTypes: string[];
  skillsInvoked: string[];
  filesWritten: string[];
  hasPrLink: boolean;
  prUrls: string[];
  hasPlanArtifact: boolean;
  turnCount: number;
}

function newCard(sessionId: string): MutableCard {
  return {
    sessionId,
    project: "",
    cwdFallback: "",
    openingPrompt: undefined,
    toolCounts: {},
    bashVerbs: {},
    subagentTypes: [],
    skillsInvoked: [],
    filesWritten: [],
    hasPrLink: false,
    prUrls: [],
    hasPlanArtifact: false,
    turnCount: 0,
  };
}

export function buildSessionCards(historyRoot: string): SessionCard[] {
  // Fallback project lookup from history.jsonl, keyed by sessionId.
  // Last-write-wins: later lines in history.jsonl overwrite earlier ones,
  // on the theory that the most recent recorded project for a sessionId is
  // most likely to be accurate for that session.
  const projectBySessionId = new Map<string, string>();
  for (const line of readHistoryLines(historyRoot)) {
    if (line.sessionId) {
      projectBySessionId.set(line.sessionId, line.project);
    }
  }

  const files = listSessionTranscriptFiles(historyRoot);
  const cards = new Map<string, MutableCard>();

  for (const file of files) {
    const rows = readSessionTranscript(file);
    if (rows.length === 0) {
      continue;
    }
    const stem = path.basename(file, ".jsonl");

    for (const rowUnknown of rows) {
      if (!rowUnknown || typeof rowUnknown !== "object") {
        continue;
      }
      const row = rowUnknown as any;
      const sessionId: string = typeof row.sessionId === "string" && row.sessionId.length > 0 ? row.sessionId : stem;
      if (!sessionId) {
        continue;
      }

      let card = cards.get(sessionId);
      if (!card) {
        card = newCard(sessionId);
        cards.set(sessionId, card);
      }

      if (row.type === "user") {
        card.turnCount += 1;
        const text = extractTextFromContent(row.message?.content);
        if (card.openingPrompt === undefined) {
          card.openingPrompt = text;
        }
        if (!card.cwdFallback && typeof row.cwd === "string") {
          card.cwdFallback = row.cwd;
        }
      } else if (row.type === "assistant") {
        const content = row.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object" || block.type !== "tool_use") {
              continue;
            }
            const name: string = typeof block.name === "string" ? block.name : "unknown";
            card.toolCounts[name] = (card.toolCounts[name] ?? 0) + 1;

            if (name === "Bash" && typeof block.input?.command === "string") {
              const verb = firstToken(block.input.command);
              if (verb) {
                card.bashVerbs[verb] = (card.bashVerbs[verb] ?? 0) + 1;
              }
            } else if (name === "Agent" && typeof block.input?.subagent_type === "string") {
              if (!card.subagentTypes.includes(block.input.subagent_type)) {
                card.subagentTypes.push(block.input.subagent_type);
              }
            } else if (name === "Skill" && typeof block.input?.skill === "string") {
              if (!card.skillsInvoked.includes(block.input.skill)) {
                card.skillsInvoked.push(block.input.skill);
              }
            } else if (name === "ExitPlanMode") {
              card.hasPlanArtifact = true;
            } else if ((name === "Write" || name === "Edit") && typeof block.input?.file_path === "string") {
              if (!card.filesWritten.includes(block.input.file_path)) {
                card.filesWritten.push(block.input.file_path);
              }
            }
          }
        }
      } else if (row.type === "pr-link") {
        card.hasPrLink = true;
        if (typeof row.prUrl === "string") {
          card.prUrls.push(row.prUrl);
        }
      }
      // Any other/unknown type: tolerantly ignored.
    }
  }

  const result: SessionCard[] = [];
  for (const card of cards.values()) {
    const project = projectBySessionId.get(card.sessionId) ?? card.cwdFallback ?? "";
    result.push({
      sessionId: card.sessionId,
      project,
      openingPrompt: card.openingPrompt ?? "",
      toolCounts: card.toolCounts,
      bashVerbs: card.bashVerbs,
      subagentTypes: card.subagentTypes,
      skillsInvoked: card.skillsInvoked,
      filesWritten: card.filesWritten,
      hasPrLink: card.hasPrLink,
      prUrls: card.prUrls,
      hasPlanArtifact: card.hasPlanArtifact,
      turnCount: card.turnCount,
    });
  }
  return result;
}
