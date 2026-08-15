/**
 * new-to-you.ts -- M6 "the learning loop": flag any bash command / tool /
 * file-type in a diff that does NOT appear anywhere in the user's own prior
 * history.
 *
 * docs/03-architecture.md: "a computed fact, not the model guessing what you
 * don't know" -- this module is pure set-membership logic. No I/O, no model
 * calls, no randomness. A separate package (`@pros/miner`) mines the user's
 * real history and writes it to disk; the caller (dashboard) reads that file
 * and passes an already-parsed `HistoryVocabulary` in here.
 */

import path from "node:path";

export interface HistoryVocabulary {
  bashVerbs: string[];
  toolNames: string[];
  fileExtensions: string[]; // includes the leading dot, e.g. ".ts", lowercased
}

export interface NewToYouCandidate {
  kind: "bash-verb" | "tool-name" | "file-extension";
  value: string; // the raw candidate value, e.g. "kubectl" or ".rs"
}

export interface NewToYouResult {
  kind: NewToYouCandidate["kind"];
  value: string;
  isNewToYou: boolean;
}

interface NormalizedVocabulary {
  bashVerbs: Set<string>;
  toolNames: Set<string>;
  fileExtensions: Set<string>;
}

function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

/** Lowercase and dedupe every entry into three Sets. File extensions are normalized to always include a leading dot. */
export function normalizeVocabulary(vocab: HistoryVocabulary): NormalizedVocabulary {
  return {
    bashVerbs: new Set(vocab.bashVerbs.map((v) => v.toLowerCase())),
    toolNames: new Set(vocab.toolNames.map((v) => v.toLowerCase())),
    fileExtensions: new Set(vocab.fileExtensions.map(normalizeExtension)),
  };
}

function normalizeCandidateValue(kind: NewToYouCandidate["kind"], value: string): string {
  if (kind === "file-extension") return normalizeExtension(value);
  return value.toLowerCase();
}

function setFor(normalized: NormalizedVocabulary, kind: NewToYouCandidate["kind"]): Set<string> {
  switch (kind) {
    case "bash-verb":
      return normalized.bashVerbs;
    case "tool-name":
      return normalized.toolNames;
    case "file-extension":
      return normalized.fileExtensions;
  }
}

/**
 * For each candidate, look it up (case-insensitively) in the matching
 * normalized vocabulary set. Pure, deterministic function of its inputs --
 * no I/O, no model calls. Preserves input order.
 */
export function checkNewToYou(vocab: HistoryVocabulary, candidates: NewToYouCandidate[]): NewToYouResult[] {
  const normalized = normalizeVocabulary(vocab);
  return candidates.map((candidate) => {
    const normalizedValue = normalizeCandidateValue(candidate.kind, candidate.value);
    const set = setFor(normalized, candidate.kind);
    return {
      kind: candidate.kind,
      value: candidate.value,
      isNewToYou: !set.has(normalizedValue),
    };
  });
}

/**
 * Small, fixed allowlist of recognizable command-ish first tokens. Gates the
 * bash-verb extraction so plain prose in added diff lines never produces a
 * false-positive "bash-verb" candidate -- false negatives (missing a real
 * new command) are fine; false positives are worse.
 */
export const KNOWN_COMMAND_TOKENS = [
  "git",
  "gh",
  "kubectl",
  "docker",
  "npm",
  "pnpm",
  "yarn",
  "python3",
  "python",
  "curl",
  "rtk",
  "tsx",
  "node",
  "cargo",
  "go",
] as const;

const KNOWN_COMMAND_TOKEN_SET = new Set<string>(KNOWN_COMMAND_TOKENS);

const ADDED_LINE_COMMAND_RE = /^\s*(?:RUN\s+|CMD\s+\[?"?)?([a-z][a-z0-9_.-]{1,20})\s/i;
const PLUS_PLUS_PLUS_RE = /^\+\+\+ (.+)$/;

/**
 * Best-effort, deterministic, regex-based extractor over a unified-diff
 * string's ADDED lines only. NOTE: this function never emits
 * `kind: "tool-name"` candidates -- tool names come from session
 * transcripts, not diff text; that candidate kind exists for completeness/
 * future callers (e.g. a dashboard feature listing tools used in a run) who
 * already know a tool name and want to check it here.
 */
export function extractCandidatesFromHunks(diffText: string): NewToYouCandidate[] {
  const candidates: NewToYouCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (kind: NewToYouCandidate["kind"], value: string) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, value });
  };

  const lines = diffText.split("\n");
  for (const line of lines) {
    const plusPlusPlus = line.match(PLUS_PLUS_PLUS_RE);
    if (plusPlusPlus) {
      const rawPath = plusPlusPlus[1]!.replace(/^b\//, "");
      if (rawPath === "/dev/null") continue;
      const ext = path.extname(rawPath).toLowerCase();
      if (ext) addCandidate("file-extension", ext);
      continue;
    }

    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    const match = added.match(ADDED_LINE_COMMAND_RE);
    if (!match) continue;
    const token = match[1]!.toLowerCase();
    if (KNOWN_COMMAND_TOKEN_SET.has(token)) {
      addCandidate("bash-verb", token);
    }
  }

  return candidates;
}
