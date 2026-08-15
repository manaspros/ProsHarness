import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mineCorrections } from "./corrections.js";
import { buildSessionCards } from "./session-cards.js";
import { clusterSessions } from "./clustering.js";
import { buildLoopProposals } from "./loops.js";
import type { CorrectionHit, LoopCluster, LoopProposal, SessionCard } from "./types.js";

export interface MiningOutput {
  generatedAt: string; // ISO timestamp
  corrections: CorrectionHit[];
  sessionCards: SessionCard[];
  clusters: LoopCluster[];
  proposals: LoopProposal[];
}

export function runMining(historyRoot: string): MiningOutput {
  const corrections = mineCorrections(historyRoot);
  const sessionCards = buildSessionCards(historyRoot);
  const clusters = clusterSessions(sessionCards);
  const proposals = buildLoopProposals(clusters, corrections, sessionCards);

  return {
    generatedAt: new Date().toISOString(),
    corrections,
    sessionCards,
    clusters,
    proposals,
  };
}

function buildHistoryVocabulary(output: MiningOutput): {
  generatedAt: string;
  bashVerbs: string[];
  toolNames: string[];
  fileExtensions: string[];
} {
  const bashVerbs = new Set<string>();
  const toolNames = new Set<string>();
  const fileExtensions = new Set<string>();

  for (const card of output.sessionCards) {
    for (const verb of Object.keys(card.bashVerbs)) {
      bashVerbs.add(verb);
    }
    for (const tool of Object.keys(card.toolCounts)) {
      toolNames.add(tool);
    }
    for (const file of card.filesWritten) {
      const ext = path.extname(file).toLowerCase();
      if (ext.length > 0) {
        fileExtensions.add(ext);
      }
    }
  }

  return {
    generatedAt: output.generatedAt,
    bashVerbs: [...bashVerbs],
    toolNames: [...toolNames],
    fileExtensions: [...fileExtensions],
  };
}

/**
 * Writes mining output to outDir. Must ONLY ever write inside outDir, never
 * touch historyRoot.
 */
export function writeMiningOutput(output: MiningOutput, outDir: string): void {
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(outDir, "proposals.json"),
    JSON.stringify({ generatedAt: output.generatedAt, proposals: output.proposals }, null, 2),
    "utf8",
  );

  writeFileSync(
    path.join(outDir, "session-cards.json"),
    JSON.stringify({ generatedAt: output.generatedAt, sessionCards: output.sessionCards }, null, 2),
    "utf8",
  );

  writeFileSync(
    path.join(outDir, "history-vocabulary.json"),
    JSON.stringify(buildHistoryVocabulary(output), null, 2),
    "utf8",
  );

  writeFileSync(
    path.join(outDir, "corrections.json"),
    JSON.stringify({ generatedAt: output.generatedAt, corrections: output.corrections }, null, 2),
    "utf8",
  );

  writeFileSync(
    path.join(outDir, "clusters.json"),
    JSON.stringify({ generatedAt: output.generatedAt, clusters: output.clusters }, null, 2),
    "utf8",
  );
}
