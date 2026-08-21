/**
 * mermaid-normalize.ts -- deterministic pre-render repair for LLM-emitted
 * Mermaid source.
 *
 * ROOT CAUSE this closes: the plan model is asked to emit raw Mermaid source
 * (packages/plan/src/plan.ts's `structured.diagram`) and that source is
 * rendered as-is by `MermaidDiagramClient.tsx`. Mermaid's flowchart grammar
 * requires a node/edge label to be double-quoted the instant it contains
 * punctuation the grammar itself uses as a token -- a comma, parens, a bare
 * `-`, a colon, and so on. Plan prose naturally contains all of these
 * ("Fix cache - fix exists, unmerged"), so an unquoted label is not a rare
 * mistake, it is the model's default output shape. Prompt wording
 * (`packages/plan/src/plan.ts`) reduces the rate but a model will keep
 * getting this wrong sometimes; this normalizer is the actual safety net.
 *
 * SCOPE -- this function only understands `graph`/`flowchart` grammar. Other
 * Mermaid diagram types (`sequenceDiagram`, `stateDiagram`/`stateDiagram-v2`,
 * `erDiagram`, `classDiagram`, `gantt`, `pie`, `journey`, `mindmap`,
 * `timeline`, `quadrantChart`, `gitGraph`, ...) have different grammars
 * entirely -- e.g. `-->` inside a sequence diagram message is a value, not a
 * flowchart edge, and a `(...)` inside an ER attribute type means something
 * else again. Blindly applying flowchart bracket/label rules to those would
 * corrupt otherwise-valid diagrams instead of fixing anything. So: detect the
 * diagram type from the first meaningful (non-blank, non `%%`-comment) line,
 * and pass every non-flowchart type through byte-for-byte untouched.
 *
 * SUBGRAPH TITLES -- this normalizer also covers a bare `subgraph <title>`
 * line, e.g. `subgraph Frontend org cache - fix exists, unmerged`. This is
 * the actual shape of the first production failure this file was written to
 * close (a comma inside an unquoted subgraph title, not a node label) --
 * confirmed against the real mermaid 11.16.1 parser on the stored diagram
 * from the run journal: `subgraph "title text"` parses, a bare unquoted
 * title with a comma does not. A subgraph line that already has an explicit
 * id plus a bracketed label (`subgraph id[title]`) is left to the node-shape
 * handling below (it is just a rect-shaped label at that point); a subgraph
 * line that is already quoted is left alone.
 *
 * CONSERVATIVE-BAILOUT RULE -- for the types this DOES handle, every
 * transformation here is a *targeted, regex-matched* rewrite of exactly one
 * shape: `A[label]`, `A(label)`, `A((label))`, `A{label}`, `A[[label]]`,
 * `A[(label)]`, `A>label]`, `A{{label}}`, a bare `subgraph <title>` line,
 * plus `-- label -->` and `-->|label|` edge labels. If a line's construct
 * does not cleanly match one
 * of those shapes (nested nodes, nested brackets inside a label, nested
 * quotes we can't safely resolve), the regex simply does not match and the
 * line is emitted unchanged. This function never attempts a "best effort"
 * rewrite of something it cannot recognize -- a diagram that still fails to
 * render post-normalization is far less harmful than one silently rewritten
 * into a different meaning. Labels that are already correctly quoted
 * (`A["already, quoted"]`) are detected and left alone (re-quoting would be
 * a no-op at best and would double-escape at worst).
 */

/** Diagram keywords this normalizer knows how to safely rewrite. */
const FLOWCHART_KEYWORDS = new Set(["graph", "flowchart"]);

/** Characters Mermaid's flowchart grammar cannot parse unquoted inside a node or edge label. */
const SPECIAL_CHARS_RE = /[,()<>{}|"#&%;:-]/;

/** A label is "already quoted" iff, once trimmed, it starts and ends with an unescaped double quote. */
function isAlreadyQuoted(trimmed: string): boolean {
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

/**
 * Quotes a label's raw (unquoted) text if it contains a character the
 * flowchart grammar would choke on. Leaves already-quoted or plain-safe text
 * untouched. Escapes an embedded `"` as `&quot;` -- Mermaid's own accepted
 * escape for a literal quote inside a quoted label -- before wrapping.
 */
function quoteLabelIfNeeded(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;
  if (isAlreadyQuoted(trimmed)) return raw;
  if (!SPECIAL_CHARS_RE.test(raw)) return raw;
  const escaped = raw.replace(/"/g, "&quot;");
  return `"${escaped}"`;
}

/**
 * One alternation covering every flowchart node shape this normalizer
 * handles, ordered from most-specific delimiter to least-specific so that,
 * say, `A[[sub]]` is recognized as a subroutine shape before the plain
 * rectangle alternative ever gets a chance to partially match it. JS regex
 * alternation tries branches in listed order at each position and commits to
 * the first one that matches, so this ordering is load-bearing.
 */
const FLOWCHART_SHAPE_RE = new RegExp(
  [
    String.raw`\(\((?<circle>[^()]*)\)\)`, // A((circle))
    String.raw`\{\{(?<hexagon>[^{}]*)\}\}`, // A{{hexagon}}
    String.raw`\[\[(?<subroutine>[^[\]]*)\]\]`, // A[[subroutine]]
    String.raw`\[\((?<cylinder>[^[\]()]*)\)\]`, // A[(cylinder)]
    String.raw`\{(?<diamond>[^{}]*)\}`, // A{diamond}
    String.raw`\((?<round>[^()]*)\)`, // A(round)
    String.raw`\[(?<rect>[^[\]]*)\]`, // A[rect]
    String.raw`(?<!-)>(?<flag>[^\]]*)\]`, // A>flag] -- lookbehind excludes the `>` of a `-->` arrow
  ].join("|"),
  "g",
);

function renderShapeMatch(groups: Record<string, string | undefined>): string {
  if (groups.circle !== undefined) return `((${quoteLabelIfNeeded(groups.circle)}))`;
  if (groups.hexagon !== undefined) return `{{${quoteLabelIfNeeded(groups.hexagon)}}}`;
  if (groups.subroutine !== undefined) return `[[${quoteLabelIfNeeded(groups.subroutine)}]]`;
  if (groups.cylinder !== undefined) return `[(${quoteLabelIfNeeded(groups.cylinder)})]`;
  if (groups.diamond !== undefined) return `{${quoteLabelIfNeeded(groups.diamond)}}`;
  if (groups.round !== undefined) return `(${quoteLabelIfNeeded(groups.round)})`;
  if (groups.rect !== undefined) return `[${quoteLabelIfNeeded(groups.rect)}]`;
  if (groups.flag !== undefined) return `>${quoteLabelIfNeeded(groups.flag)}]`;
  // Unreachable: the regex only ever matches via one of the named groups above.
  return "";
}

/** `-->|edge label|` and bare `|edge label|` pipe-delimited edge labels. */
const PIPE_EDGE_LABEL_RE = /\|([^|]*)\|/g;

/** `A -- edge label --> B` inline dash-delimited edge labels (space-bounded, so it never matches a bare `-->` or `-.->`). */
const DASH_EDGE_LABEL_RE = /--\s+([^\n]+?)\s+-->/g;

/** A `subgraph` line, capturing the `subgraph` keyword plus its separating whitespace, and everything after it verbatim (including trailing whitespace, which is dropped when we rewrite). */
const SUBGRAPH_LINE_RE = /^(\s*subgraph\s+)(.*)$/;

/**
 * Rewrites a bare, unquoted `subgraph <title>` line to `subgraph "<title>"`
 * when the title contains a character the grammar can't parse unquoted.
 * Left alone: an already-quoted title, an `id[label]`/`id["label"]` title
 * (handled by the general node-shape pass instead, since it's just a rect
 * label at that point), a title with no risky characters, and a bare
 * `subgraph` with nothing after it.
 */
function normalizeSubgraphLine(line: string): string {
  const match = line.match(SUBGRAPH_LINE_RE);
  if (!match) return line;
  const [, prefix, rest] = match;
  const title = rest.trimEnd();
  if (title.length === 0) return line;
  const titleTrimmed = title.trim();
  if (isAlreadyQuoted(titleTrimmed)) return line;
  if (titleTrimmed.includes("[")) return line;
  if (!SPECIAL_CHARS_RE.test(titleTrimmed)) return line;
  const escaped = titleTrimmed.replace(/"/g, "&quot;");
  return `${prefix}"${escaped}"`;
}

function normalizeFlowchartLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("%%")) return line;

  // Quote a bare subgraph title first, but do NOT short-circuit: a subgraph
  // line normalizeSubgraphLine declines to touch (already quoted, or the
  // `id[label]` form) still needs to fall through to the general node-shape
  // pass below, which is what actually normalizes an unquoted `id[label]`.
  const afterSubgraph = SUBGRAPH_LINE_RE.test(trimmed) ? normalizeSubgraphLine(line) : line;

  let out = afterSubgraph.replace(FLOWCHART_SHAPE_RE, (_match, ...rest) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    return renderShapeMatch(groups);
  });

  out = out.replace(PIPE_EDGE_LABEL_RE, (_match, label: string) => `|${quoteLabelIfNeeded(label)}|`);

  out = out.replace(DASH_EDGE_LABEL_RE, (_match, label: string) => `-- ${quoteLabelIfNeeded(label)} -->`);

  return out;
}

/** Returns the first non-blank, non-comment line's leading keyword, lowercased -- e.g. "graph", "flowchart", "sequencediagram". Empty string if the source has no such line. */
function detectDiagramKeyword(source: string): string {
  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("%%")) continue;
    const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
    return firstToken.toLowerCase();
  }
  return "";
}

/**
 * Normalizes raw model-emitted Mermaid source so it is far more likely to
 * parse, without changing what a well-formed diagram would have meant.
 *
 * Only `graph` and `flowchart` sources are rewritten. Every other diagram
 * type (sequence, state, ER, class, gantt, pie, journey, mindmap, timeline,
 * quadrant, git graph, ...) is returned byte-for-byte unchanged, because this
 * function does not understand their grammars and a wrong guess there would
 * corrupt a diagram that might otherwise have rendered fine.
 */
export function normalizeMermaidSource(source: string): string {
  if (typeof source !== "string" || source.length === 0) return source;
  const keyword = detectDiagramKeyword(source);
  if (!FLOWCHART_KEYWORDS.has(keyword)) return source;
  return source
    .split("\n")
    .map((line) => normalizeFlowchartLine(line))
    .join("\n");
}
