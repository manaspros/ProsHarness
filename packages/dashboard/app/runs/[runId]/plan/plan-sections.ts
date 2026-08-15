/**
 * Pure logic for the plan page's right-rail "jump to section" feature:
 * split a plan's markdown into heading-anchored sections (so each can be
 * rendered as its own `<div id="...">` wrapping a `<PlanMarkdown>`, giving
 * every heading a stable scroll target without needing to modify the
 * shared PlanMarkdown component or add a rehype/remark plugin dependency),
 * and best-effort match an objection's claim text against those headings.
 *
 * Matching is deliberately conservative: per the brief, "if no confident
 * match, skip the link rather than guessing wrong." A match requires the
 * heading's normalized text (a handful of characters or more) to appear as
 * a substring of the objection's normalized claim text. Short/generic
 * headings (e.g. a bare "Risk") are excluded from matching to avoid
 * trivial false positives.
 */

export interface PlanSection {
  /** Stable DOM id, derived from the heading text (or "preamble" for any
   * content before the first heading). Unique within one document via a
   * numeric suffix on collisions. */
  id: string;
  /** The heading text itself, or undefined for the preamble section. */
  heading: string | undefined;
  /** This section's raw markdown slice (heading line + body), fed straight
   * into <PlanMarkdown>. */
  markdown: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/**
 * Splits markdown at every ATX heading line (`# ...` through `###### ...`).
 * Content before the first heading (if any, and non-blank) becomes a
 * "preamble" section with no heading/id-from-text (id "preamble").
 */
export function splitMarkdownIntoSections(markdown: string): PlanSection[] {
  const lines = markdown.split("\n");
  const sections: PlanSection[] = [];
  let currentHeading: string | undefined;
  let currentLines: string[] = [];
  const usedIds = new Set<string>();

  function flush(): void {
    const body = currentLines.join("\n").trim();
    if (!body) {
      currentLines = [];
      return;
    }
    const baseId = currentHeading ? slugify(currentHeading) : "preamble";
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${n}`;
      n++;
    }
    usedIds.add(id);
    sections.push({ id, heading: currentHeading, markdown: body });
    currentLines = [];
  }

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      currentHeading = match[2]!.trim();
    }
    currentLines.push(line);
  }
  flush();

  return sections;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Headings shorter than this (normalized) are considered too generic to match on confidently. */
const MIN_HEADING_LEN = 5;

/**
 * Best-effort: find the section whose heading text is a confident
 * substring match within the objection's claim text. Returns undefined
 * (no link rendered) rather than guessing when nothing qualifies.
 */
export function findMatchingSection(claim: string | null, sections: PlanSection[]): PlanSection | undefined {
  if (!claim) return undefined;
  const normalizedClaim = normalize(claim);
  if (!normalizedClaim) return undefined;

  let best: PlanSection | undefined;
  let bestLen = 0;
  for (const section of sections) {
    if (!section.heading) continue;
    const normalizedHeading = normalize(section.heading);
    if (normalizedHeading.length < MIN_HEADING_LEN) continue;
    if (normalizedClaim.includes(normalizedHeading) && normalizedHeading.length > bestLen) {
      best = section;
      bestLen = normalizedHeading.length;
    }
  }
  return best;
}
