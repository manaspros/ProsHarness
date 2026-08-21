import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMermaidSource } from "../lib/mermaid-normalize.js";

const RAW_DIAGRAM = [
  "flowchart TD",
  "    A[Skill import request e.g. cloudflare] --> B{Marketplace clone/refresh}",
  "    B --> C[Gateway assembles marketplace tree]",
  "    C --> D{.git paths present? F1}",
  "    D -- fix written, unmerged --> E[Checkout fails, client may rm -rf registration F3]",
  "    D -- after merge+deploy --> F{Size budget check F2 - one call site, line 707}",
  "    F -- no fix yet, oversized contribution silently dropped --> G[Intermittent HTTP 413]",
  "    F -- after new per-skill cap ships --> H[Marketplace served OK, oversized skill rejected cleanly]",
  "    E --> I[Retry hits bare 401, nothing to refresh]",
  "    G --> I",
  "    I --> J[Onboarding widget shows dead Retry, skips items]",
  "    H --> K[Skill installs successfully]",
  "    subgraph Frontend org cache - fix exists, unmerged",
  "        L[cache_key now scoped by identity + name on plugin-install-atlanai branch] --> M[Merge + security review before landing]",
  "    end",
  "    subgraph F3 candidate - unverified",
  "        N[gateway-git-credential branch claims to stop deletion-on-refresh] --> O[Must diff to confirm before trusting]",
  "    end",
  "    K --> L",
  "    E --> N",
].join("\n");

test("real-file regression: the exact stored diagram from the run journal, byte length sanity check", () => {
  assert.equal(RAW_DIAGRAM.length, 1086);
});

test("real-file regression: normalizing the stored diagram quotes the failing subgraph title (line 13)", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  assert.match(out, /subgraph "Frontend org cache - fix exists, unmerged"/);
  assert.doesNotMatch(out, /\n    subgraph Frontend org cache - fix exists, unmerged\n/);
});

test("real-file regression: the second subgraph title (line 16) is also quoted", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  assert.match(out, /subgraph "F3 candidate - unverified"/);
});

test("real-file regression: the matching end lines are untouched", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  const endLines = out.split("\n").filter((l) => l.trim() === "end");
  assert.equal(endLines.length, 2);
});

test("real-file regression: all three unquoted dash-edge labels (lines 5, 7, 8) are quoted", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  assert.match(out, /D -- "fix written, unmerged" --> E/);
  assert.match(out, /F -- "no fix yet, oversized contribution silently dropped" --> G/);
  assert.match(out, /F -- "after new per-skill cap ships" --> H/);
});

test("real-file regression: node labels containing commas are quoted, e.g. line 14's cache_key label", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  assert.match(out, /L\["cache_key now scoped by identity \+ name on plugin-install-atlanai branch"\]/);
});

test("real-file regression: an edge with no risky characters is left unquoted", () => {
  const out = normalizeMermaidSource(RAW_DIAGRAM);
  assert.match(out, /D -- after merge\+deploy --> F/);
});
