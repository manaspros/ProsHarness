/**
 * hunks.ts -- risk-ranked hunks for the M5 review page.
 *
 * docs/03-architecture.md's "Review and teach" section, point 3:
 *   "Risk-ranked hunks, not file-ordered. Lockfiles, generated files and
 *   pure reformatting collapsed by default."
 *
 * This module shells out to a real `git diff` (unified, zero context lines
 * so hunk boundaries are exact) between two shas in a real repo/worktree,
 * parses the unified-diff hunk headers itself (no new dependency -- this is
 * a small, well-understood grammar), and assigns each hunk a deterministic
 * risk score from a handful of named, documented weights (never a
 * black-box/opaque number).
 *
 * DETERMINISM: given the same repo/shas/options, two calls MUST produce
 * deep-equal output. Every input to the score is either static text
 * (path/patch content) or explicit caller-supplied data
 * (verificationFailingChecks/reviewObjections) -- no randomness, no
 * wall-clock, no unsorted directory listing feeds the score or the final
 * ordering. Ties are broken by (file path, startLine) so the sort itself is
 * stable across runs/machines/Node versions.
 *
 * Sync API (execFileSync/readFileSync), matching the interface shape
 * requested for this module -- risk ranking runs against an already-fetched
 * local repo/worktree, so there's no need to pay for the async plumbing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Hunk {
  file: string;
  startLine: number; // in the new/head version
  lineCount: number;
  addedLines: number;
  removedLines: number;
  patchText: string; // the raw unified-diff hunk text, for display
  /** Deterministic 0-100+ risk score -- higher = more important to review first. */
  riskScore: number;
  riskFactors: string[]; // human-readable reasons
  /** Lockfiles, generated files, pure whitespace/reformatting -- collapsed by default in the UI. */
  collapsedByDefault: boolean;
}

export interface RiskRankedDiff {
  hunks: Hunk[]; // sorted by riskScore descending
  totalFiles: number;
  totalAddedLines: number;
  totalRemovedLines: number;
}

export interface RiskRankOptions {
  repoRoot: string; // a real git repo (or worktree) -- baseSha/headSha must both be reachable there
  baseSha: string;
  headSha: string;
  /** Optional: from a recorded Verdict -- files/checks verification flagged. If provided, hunks touching a failingCheck-referenced file get a risk bump. */
  verificationFailingChecks?: string[];
  /** Optional: from recorded review Objections -- if any blocker/major objection's claim text mentions a file, bump that file's hunks. */
  reviewObjections?: Array<{ severity: string; claim: string }>;
}

// ---------------------------------------------------------------------------
// Named, documented scoring weights -- explainable, not a black box.
// ---------------------------------------------------------------------------

/** Hunk-size contribution is capped so one giant hunk can't totally dominate ordering vs. several risky small ones. */
export const MAX_SIZE_SCORE = 50;
/** Large negative so lockfiles/generated content always sort to the bottom, regardless of size. */
export const GENERATED_OR_LOCKFILE_PENALTY = -1000;
/** Pure-whitespace/reformatting hunks are collapsed and scored near zero -- not actively penalized (they're real content, just low-signal), just not prioritized. */
export const WHITESPACE_ONLY_SCORE = 1;
/** Added per distinct sensitive keyword matched (path or added-line text). */
export const KEYWORD_BONUS = 25;
/** Added when the touched file has no plausible sibling test on disk. */
export const NO_TEST_COVERAGE_BONUS = 15;
/** Large bonus: verification itself flagged this file as implicated in a failing check. */
export const VERIFICATION_FLAG_BONUS = 100;
/** Bonus when an adversarial-review objection's claim text cites this file. */
export const REVIEW_OBJECTION_BONUS = 40;

/** Keyword list for the "touches something sensitive" bonus (docs/03-architecture.md: auth/payments/migrations/concurrency). */
export const RISK_KEYWORDS = [
  "auth",
  "payment",
  "migration",
  "concurrency",
  "lock",
  "mutex",
  "race",
  "token",
  "credential",
  "permission",
] as const;

const LOCKFILE_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

function isLockfile(file: string): boolean {
  return LOCKFILE_NAMES.has(path.basename(file));
}

function isGeneratedPath(file: string): boolean {
  return file.includes("/dist/") || file.includes("/generated/") || file.endsWith(".min.js");
}

/** Best-effort, tolerant of missing/deleted files (returns false rather than throwing). */
function hasGeneratedMarker(repoRoot: string, file: string): boolean {
  try {
    const full = path.join(repoRoot, file);
    if (!existsSync(full)) return false;
    // Only the first ~2KB needs scanning -- generated-file markers are
    // always a leading banner comment, never buried deep in the file.
    const head = readFileSync(full, "utf8").slice(0, 2048);
    return /\/\/\s*AUTO-GENERATED|@generated/i.test(head);
  } catch {
    return false;
  }
}

function stripWhitespace(line: string): string {
  return line.replace(/\s+/g, "");
}

/**
 * True if this hunk is pure reformatting: every added line, whitespace-
 * stripped, is also present (as a stripped form) among the removed lines,
 * and vice versa -- i.e. the same multiset of "real" content, just
 * rewrapped/reindented.
 */
function isWhitespaceOnlyHunk(addedRaw: string[], removedRaw: string[]): boolean {
  if (addedRaw.length === 0 && removedRaw.length === 0) return false;
  const addedStripped = addedRaw.map(stripWhitespace).sort();
  const removedStripped = removedRaw.map(stripWhitespace).sort();
  if (addedStripped.length !== removedStripped.length) return false;
  return addedStripped.every((v, i) => v === removedStripped[i]);
}

/**
 * Heuristic sibling-test check: for `packages/foo/src/bar.ts`, look for
 * `packages/foo/test/bar.test.ts` or any file under that package's `test/`
 * directory whose name contains `bar`. Files that don't match the
 * `packages/<pkg>/src/...` shape are treated as "heuristic not applicable"
 * (no bonus, no factor) rather than guessed at.
 */
function hasNoApparentTestCoverage(repoRoot: string, file: string): boolean {
  const match = file.match(/^packages\/([^/]+)\/src\/(.+)$/);
  if (!match) return false;
  const [, pkg, rest] = match;
  const base = path.basename(rest!, path.extname(rest!));
  const testDir = path.join(repoRoot, "packages", pkg!, "test");
  if (!existsSync(testDir)) return true;
  let names: string[];
  try {
    names = readdirSync(testDir);
  } catch {
    return true;
  }
  const hasSibling = names.some((n) => n.includes(base));
  return !hasSibling;
}

interface ParsedHunk {
  file: string;
  startLine: number;
  addedLines: number;
  removedLines: number;
  addedText: string[];
  removedText: string[];
  patchText: string;
}

/** Splits full multi-file unified diff text into one chunk per `diff --git` section. */
function splitFileSections(raw: string): string[] {
  const lines = raw.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length) sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

function parseFileSection(section: string): ParsedHunk[] {
  const lines = section.split("\n");

  let newPath: string | undefined;
  let oldPath: string | undefined;
  for (const line of lines) {
    const plus = line.match(/^\+\+\+ (.+)$/);
    if (plus) newPath = plus[1] === "/dev/null" ? undefined : plus[1]!.replace(/^b\//, "");
    const minus = line.match(/^--- (.+)$/);
    if (minus) oldPath = minus[1] === "/dev/null" ? undefined : minus[1]!.replace(/^a\//, "");
  }
  const file = newPath ?? oldPath;
  if (!file) return [];

  const hunks: ParsedHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!.match(HUNK_HEADER_RE);
    if (!header) {
      i++;
      continue;
    }
    const newStart = Number(header[3]);
    const bodyLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !HUNK_HEADER_RE.test(lines[j]!) && !lines[j]!.startsWith("diff --git ")) {
      bodyLines.push(lines[j]!);
      j++;
    }
    const addedText = bodyLines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    const removedText = bodyLines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    hunks.push({
      file,
      startLine: newStart,
      addedLines: addedText.length,
      removedLines: removedText.length,
      addedText,
      removedText,
      patchText: [lines[i], ...bodyLines].join("\n"),
    });
    i = j;
  }
  return hunks;
}

function gitDiff(repoRoot: string, baseSha: string, headSha: string): string {
  return execFileSync("git", ["diff", "--unified=0", baseSha, headSha], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
}

/** Shared internal collection step, reused by both rankHunks and buildFocusChecklist (see checklist.ts doc comment). */
export function collectParsedHunks(opts: RiskRankOptions): ParsedHunk[] {
  const raw = gitDiff(opts.repoRoot, opts.baseSha, opts.headSha);
  const sections = splitFileSections(raw);
  const all: ParsedHunk[] = [];
  for (const section of sections) {
    all.push(...parseFileSection(section));
  }
  return all;
}

function scoreHunk(parsed: ParsedHunk, opts: RiskRankOptions): { hunk: Hunk } {
  const { file } = parsed;
  const riskFactors: string[] = [];
  let collapsedByDefault = false;
  let score: number;

  const lockfile = isLockfile(file);
  const generated = isGeneratedPath(file) || hasGeneratedMarker(opts.repoRoot, file);
  const whitespaceOnly = isWhitespaceOnlyHunk(parsed.addedText, parsed.removedText);

  if (lockfile || generated) {
    collapsedByDefault = true;
    score = GENERATED_OR_LOCKFILE_PENALTY;
    riskFactors.push(lockfile ? "lockfile -- collapsed by default" : "generated file -- collapsed by default");
  } else if (whitespaceOnly) {
    collapsedByDefault = true;
    score = WHITESPACE_ONLY_SCORE;
    riskFactors.push("pure whitespace/reformatting -- collapsed by default");
  } else {
    const lineCount = parsed.addedLines + parsed.removedLines;
    score = Math.min(lineCount, MAX_SIZE_SCORE);

    const haystack = `${file}\n${parsed.addedText.join("\n")}`.toLowerCase();
    const matchedKeywords = RISK_KEYWORDS.filter((kw) => haystack.includes(kw));
    for (const kw of matchedKeywords) {
      score += KEYWORD_BONUS;
      riskFactors.push(`touches keyword: ${kw}`);
    }

    if (hasNoApparentTestCoverage(opts.repoRoot, file)) {
      score += NO_TEST_COVERAGE_BONUS;
      riskFactors.push("no apparent test coverage");
    }
  }

  if (opts.verificationFailingChecks?.some((c) => c.toLowerCase().includes(file.toLowerCase()))) {
    score += VERIFICATION_FLAG_BONUS;
    riskFactors.push("verification flagged this file");
  }

  if (
    opts.reviewObjections?.some(
      (o) => (o.severity === "blocker" || o.severity === "major") && o.claim.toLowerCase().includes(file.toLowerCase()),
    )
  ) {
    score += REVIEW_OBJECTION_BONUS;
    riskFactors.push("reviewer raised a concern citing this file");
  }

  return {
    hunk: {
      file: parsed.file,
      startLine: parsed.startLine,
      lineCount: parsed.addedLines + parsed.removedLines,
      addedLines: parsed.addedLines,
      removedLines: parsed.removedLines,
      patchText: parsed.patchText,
      riskScore: score,
      riskFactors,
      collapsedByDefault,
    },
  };
}

export function rankHunks(opts: RiskRankOptions): RiskRankedDiff {
  const parsed = collectParsedHunks(opts);
  const hunks = parsed.map((p) => scoreHunk(p, opts).hunk);

  hunks.sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.startLine - b.startLine;
  });

  const files = new Set(hunks.map((h) => h.file));
  const totalAddedLines = hunks.reduce((sum, h) => sum + h.addedLines, 0);
  const totalRemovedLines = hunks.reduce((sum, h) => sum + h.removedLines, 0);

  return {
    hunks,
    totalFiles: files.size,
    totalAddedLines,
    totalRemovedLines,
  };
}
