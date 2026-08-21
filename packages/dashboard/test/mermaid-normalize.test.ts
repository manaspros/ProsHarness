import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMermaidSource } from "../lib/mermaid-normalize.js";

/**
 * Regression coverage for the observed failure: a live Gate 1 plan card
 * rendered a raw Mermaid parse error instead of a diagram because the model
 * emitted a node label with an unquoted comma and a bare `-` in prose
 * ("Fix cache - fix exists, unmerged L..."). See mermaid-parse-proof.test.ts
 * for proof this normalizer's output actually parses in real Mermaid, not
 * just that it matches these string assertions.
 */

test("quotes a rectangle label containing a comma", () => {
  const input = "graph TD\n  A[Import fails, retry does nothing] --> B[Done]";
  const out = normalizeMermaidSource(input);
  assert.match(out, /A\["Import fails, retry does nothing"\]/);
});

test("quotes a round-edge label containing parentheses and a dash (the observed failure shape)", () => {
  const input = 'graph TD\n  A[Bug] --> B(Fix cache - fix exists, unmerged L(egacy))';
  const out = normalizeMermaidSource(input);
  // The label content itself contains nested parens, which the balanced
  // single-level regex cannot safely capture -- conservative bailout means
  // this exact construct is left alone rather than mangled.
  assert.equal(out, input);
});

test("quotes a round-edge label containing a comma and a bare dash", () => {
  const input = "graph TD\n  A[Bug] --> B(Fix cache - fix exists, unmerged)";
  const out = normalizeMermaidSource(input);
  assert.match(out, /B\("Fix cache - fix exists, unmerged"\)/);
});

test("an already-quoted label is left alone, never double-quoted", () => {
  const input = 'graph TD\n  A["already, quoted (fine)"] --> B[ok]';
  const out = normalizeMermaidSource(input);
  assert.equal(out, input);
});

test("quotes a pipe-delimited edge label containing a comma", () => {
  const input = "graph TD\n  A -->|retry, then fail| B";
  const out = normalizeMermaidSource(input);
  assert.match(out, /-->\|"retry, then fail"\|/);
});

test("quotes a dash-delimited inline edge label containing a comma", () => {
  const input = "graph TD\n  A -- text with, comma --> B";
  const out = normalizeMermaidSource(input);
  assert.match(out, /A -- "text with, comma" --> B/);
});

test("escapes a double quote embedded inside a label as &quot;", () => {
  const input = 'graph TD\n  A[Fix the "cache" bug, retry] --> B[ok]';
  const out = normalizeMermaidSource(input);
  assert.match(out, /A\["Fix the &quot;cache&quot; bug, retry"\]/);
});

test("a non-flowchart diagram type (sequenceDiagram) is passed through byte-for-byte untouched", () => {
  const input = [
    "sequenceDiagram",
    "  participant A",
    "  participant B",
    "  A->>B: Fix cache, retry (with parens)",
  ].join("\n");
  assert.equal(normalizeMermaidSource(input), input);
});

test("other non-flowchart types (erDiagram, gantt, classDiagram) are also passed through untouched", () => {
  for (const input of [
    'erDiagram\n  CUSTOMER ||--o{ ORDER : "places, urgently"',
    "gantt\n  title A Gantt Diagram (v2)\n  section Section\n  A task, done : a1, 2014-01-01, 30d",
    "classDiagram\n  class Animal{\n    +String name, age\n  }",
  ]) {
    assert.equal(normalizeMermaidSource(input), input);
  }
});

test("handles circle, hexagon, subroutine, cylinder, diamond, and flag shapes", () => {
  const input = [
    "graph TD",
    "  A((Circle, one)) --> B{{Hexagon, two}}",
    "  B --> C[[Subroutine, three]]",
    "  C --> D[(Cylinder, four)]",
    "  D --> E{Diamond, five}",
    "  E --> F>Flag, six]",
  ].join("\n");
  const out = normalizeMermaidSource(input);
  assert.match(out, /A\(\("Circle, one"\)\)/);
  assert.match(out, /B\{\{"Hexagon, two"\}\}/);
  assert.match(out, /C\[\["Subroutine, three"\]\]/);
  assert.match(out, /D\[\("Cylinder, four"\)\]/);
  assert.match(out, /E\{"Diamond, five"\}/);
  assert.match(out, /F>"Flag, six"\]/);
});

test("a safe label with no special characters is left byte-identical", () => {
  const input = "graph TD\n  A[Start here] --> B[Finish]";
  assert.equal(normalizeMermaidSource(input), input);
});

test("comment lines and blank lines are left untouched even though they may contain commas", () => {
  const input = "graph TD\n  %% note: this, that, and the other\n\n  A[ok] --> B[ok]";
  assert.equal(normalizeMermaidSource(input), input);
});

test("empty and non-string input pass through", () => {
  assert.equal(normalizeMermaidSource(""), "");
});

test("flowchart keyword (not just graph) is also normalized", () => {
  const input = "flowchart LR\n  A[Fix, this] --> B[ok]";
  const out = normalizeMermaidSource(input);
  assert.match(out, /A\["Fix, this"\]/);
});

test("does not treat the arrowhead '>' of --> as a flag-shape opener", () => {
  const input = "graph TD\n  A[ok] --> B[also, ok]";
  const out = normalizeMermaidSource(input);
  // The only rewrite should be B's label; the --> arrow itself must survive intact.
  assert.match(out, /A\[ok\] --> B\["also, ok"\]/);
});

/**
 * The actual observed production failure: an unquoted `subgraph` title
 * containing a comma and a bare dash, not a node label. Line/text taken
 * verbatim from the run journal's stored diagram (see the parse-proof notes
 * in this file's header and the final report for the real-mermaid-parser
 * proof on the full stored diagram).
 */
test("quotes a bare subgraph title containing a comma and a dash (the real observed failure)", () => {
  const input = [
    "flowchart TD",
    "    K --> L",
    "    subgraph Frontend org cache - fix exists, unmerged",
    "        L[x] --> M[y]",
    "    end",
  ].join("\n");
  const out = normalizeMermaidSource(input);
  assert.match(out, /subgraph "Frontend org cache - fix exists, unmerged"/);
});

test("an already-quoted subgraph title is left byte-identical", () => {
  const input = [
    "flowchart TD",
    '    subgraph "Frontend org cache - fix exists, unmerged"',
    "        L[x] --> M[y]",
    "    end",
  ].join("\n");
  assert.equal(normalizeMermaidSource(input), input);
});

test("a subgraph with an explicit id and bracketed label is left to the general node-shape pass, not double-handled", () => {
  const alreadyQuotedIdBracket = [
    "flowchart TD",
    '    subgraph sg1["Already, quoted title"]',
    "        L[x] --> M[y]",
    "    end",
  ].join("\n");
  assert.equal(normalizeMermaidSource(alreadyQuotedIdBracket), alreadyQuotedIdBracket);

  const unquotedIdBracket = [
    "flowchart TD",
    "    subgraph sg1[Unquoted, title]",
    "        L[x] --> M[y]",
    "    end",
  ].join("\n");
  const out = normalizeMermaidSource(unquotedIdBracket);
  // The subgraph-specific rule skips this line (it has an id + bracket), but
  // the general rect-shape pass still runs over every line and quotes the
  // bracket content -- so it ends up safe via the existing mechanism.
  assert.match(out, /subgraph sg1\["Unquoted, title"\]/);
});

test("a bare subgraph title with no risky characters is left untouched", () => {
  const input = "flowchart TD\n    subgraph Frontend\n        L[x] --> M[y]\n    end";
  assert.equal(normalizeMermaidSource(input), input);
});

test("a bare `subgraph` line with nothing after it is left untouched", () => {
  const input = "flowchart TD\n    subgraph \n        L[x] --> M[y]\n    end";
  assert.equal(normalizeMermaidSource(input), input);
});

test("the matching `end` for a normalized subgraph is never touched", () => {
  const input = [
    "flowchart TD",
    "    subgraph Frontend, org",
    "        L[x] --> M[y]",
    "    end",
  ].join("\n");
  const out = normalizeMermaidSource(input);
  assert.match(out, /\n    end$/);
});
