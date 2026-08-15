import os from "node:os";
import path from "node:path";
import { resolveHistoryRoot } from "../src/history-source.js";
import { runMining, writeMiningOutput } from "../src/mine.js";

function resolveOutDir(): string {
  const fromEnv = process.env.PROS_MINER_OUT;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".pros", "miner");
}

const historyRoot = resolveHistoryRoot();
const outDir = resolveOutDir();

const output = runMining(historyRoot);
writeMiningOutput(output, outDir);

// Counts only -- never print quote/prompt/session content to stdout.
console.log(
  `mined: ${output.sessionCards.length} sessions, ${output.corrections.length} corrections, ${output.clusters.length} clusters, ${output.proposals.length} proposals -> ${outDir}`,
);
