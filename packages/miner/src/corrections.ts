import { readHistoryLines } from "./history-source.js";
import type { CorrectionHit } from "./types.js";

// Calibrated regexes, tuned against the real dataset -- use exactly these.
const REVERT = /revert/i;
const STILL_BROKEN =
  /still (broken|not working|failing|wrong|there|happening|the same|an issue)|didn.t work|doesn.t work|isn.t working|not working|has.n.t worked/i;
const NO_WRONG = /^(no[,.!]|no you|no that|nope)|\bwrong\b|\bnot correct\b|\bincorrect\b|that.s not (right|what)|you.re wrong/i;
const I_TOLD_YOU = /i (told|said)|as i (mentioned|said)|i already (said|told)/i;

export function mineCorrections(historyRoot: string): CorrectionHit[] {
  const lines = readHistoryLines(historyRoot);
  const hits: CorrectionHit[] = [];
  for (const line of lines) {
    const base = {
      sessionId: line.sessionId,
      project: line.project,
      timestampMs: line.timestamp,
      quote: line.display,
      lineIndex: line.lineIndex,
    };
    if (REVERT.test(line.display)) {
      hits.push({ ...base, category: "revert" });
    }
    if (STILL_BROKEN.test(line.display)) {
      hits.push({ ...base, category: "still-broken" });
    }
    if (NO_WRONG.test(line.display)) {
      hits.push({ ...base, category: "no-wrong" });
    }
    if (I_TOLD_YOU.test(line.display)) {
      hits.push({ ...base, category: "i-told-you" });
    }
  }
  return hits;
}
