/**
 * checklist.ts -- Focus checklist for the M5 review page.
 *
 * docs/03-architecture.md's "Review and teach" section, point 4:
 *   "Focus checklist -- untested branches, changed error handling, new
 *   external calls, concurrency changes."
 *
 * Deliberately does NOT re-shell to git: `rankHunks` (hunks.ts) already
 * parsed every hunk's unified-diff body into `Hunk.patchText`, and computed
 * `Hunk.riskFactors` (which already know about "no apparent test coverage",
 * "verification flagged this file", "reviewer raised a concern citing this
 * file") -- this module just re-derives checklist items from that same,
 * already-computed data, so the two views (risk-ranked hunks / focus
 * checklist) can never disagree about what the diff actually contains.
 */

import type { Hunk, RiskRankedDiff, RiskRankOptions } from "./hunks.js";

export interface ChecklistItem {
  category:
    | "untested_branch"
    | "error_handling_changed"
    | "new_external_call"
    | "concurrency_change"
    | "verification_flag"
    | "review_objection";
  description: string;
  file: string;
  line?: number;
}

/** Small, documented keyword lists -- not exhaustive, but the common/likely-risky forms. */
const EXTERNAL_CALL_KEYWORDS = ["fetch(", "execFile(", "exec(", "spawn(", "http.request(", "axios."];
const CONCURRENCY_KEYWORDS = ["Promise.all", "async ", "await ", "setInterval", "setTimeout", "mutex", "lock("];

/** Maps each line in a hunk's patch body to its line number in the new/head file (unified=0: only "+" lines consume new-file numbering). */
function addedLinesWithNumbers(hunk: Hunk): Array<{ text: string; line: number }> {
  const bodyLines = hunk.patchText.split("\n").slice(1); // drop the "@@ ... @@" header
  const out: Array<{ text: string; line: number }> = [];
  let n = hunk.startLine;
  for (const raw of bodyLines) {
    if (raw.startsWith("+")) {
      out.push({ text: raw.slice(1), line: n });
      n++;
    }
    // "-" lines don't consume new-file line numbers; nothing else appears
    // in a --unified=0 hunk body besides +/- lines.
  }
  return out;
}

function removedLines(hunk: Hunk): string[] {
  return hunk.patchText
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith("-"))
    .map((l) => l.slice(1));
}

export function buildFocusChecklist(diff: RiskRankedDiff, _opts: RiskRankOptions): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const untestedFilesSeen = new Set<string>();

  for (const hunk of diff.hunks) {
    // A purely collapsed (lockfile/generated/whitespace-only) hunk carries
    // no reviewable signal for any checklist category -- skip it entirely.
    if (hunk.collapsedByDefault) continue;

    const added = addedLinesWithNumbers(hunk);
    const removed = removedLines(hunk);

    for (const { text, line } of added) {
      const lower = text.toLowerCase();
      const matchedCall = EXTERNAL_CALL_KEYWORDS.find((kw) => text.includes(kw));
      if (matchedCall) {
        items.push({
          category: "new_external_call",
          description: `New external call added in ${hunk.file}:${line} -- ${text.trim()}`,
          file: hunk.file,
          line,
        });
      }
      if (lower.includes("catch") || lower.includes("throw")) {
        items.push({
          category: "error_handling_changed",
          description: `Error handling changed in ${hunk.file}:${line} -- ${text.trim()}`,
          file: hunk.file,
          line,
        });
      }
      if (CONCURRENCY_KEYWORDS.some((kw) => text.includes(kw))) {
        items.push({
          category: "concurrency_change",
          description: `Concurrency-related change in ${hunk.file}:${line} -- ${text.trim()}`,
          file: hunk.file,
          line,
        });
      }
    }

    // Error handling changes also matter on the removed side (a catch/throw
    // being deleted is just as review-worthy as one being added) -- no
    // reliable new-file line number for a pure deletion, so line is omitted.
    for (const text of removed) {
      const lower = text.toLowerCase();
      if (lower.includes("catch") || lower.includes("throw")) {
        items.push({
          category: "error_handling_changed",
          description: `Error handling changed (removed) in ${hunk.file} -- ${text.trim()}`,
          file: hunk.file,
        });
      }
    }

    if (hunk.riskFactors.includes("no apparent test coverage") && !untestedFilesSeen.has(hunk.file)) {
      untestedFilesSeen.add(hunk.file);
      items.push({
        category: "untested_branch",
        description: `${hunk.file} has no apparent sibling test coverage`,
        file: hunk.file,
      });
    }

    if (hunk.riskFactors.includes("verification flagged this file")) {
      items.push({
        category: "verification_flag",
        description: `Verification flagged ${hunk.file}:${hunk.startLine}`,
        file: hunk.file,
        line: hunk.startLine,
      });
    }

    if (hunk.riskFactors.includes("reviewer raised a concern citing this file")) {
      items.push({
        category: "review_objection",
        description: `A reviewer objection cites ${hunk.file}:${hunk.startLine}`,
        file: hunk.file,
        line: hunk.startLine,
      });
    }
  }

  // Deterministic order: category, then file, then line (undefined sorts last).
  items.sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const al = a.line ?? Number.MAX_SAFE_INTEGER;
    const bl = b.line ?? Number.MAX_SAFE_INTEGER;
    return al - bl;
  });

  return items;
}
