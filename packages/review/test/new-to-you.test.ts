import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeVocabulary,
  checkNewToYou,
  extractCandidatesFromHunks,
  type HistoryVocabulary,
} from "../src/new-to-you.js";

test("normalizeVocabulary: mixed-case input, extension without leading dot, dedupe", () => {
  const vocab: HistoryVocabulary = {
    bashVerbs: ["Git", "git", "GH"],
    toolNames: ["Bash", "bash", "Read"],
    fileExtensions: ["ts", ".TS", ".md"],
  };
  const normalized = normalizeVocabulary(vocab);

  assert.deepEqual([...normalized.bashVerbs].sort(), ["gh", "git"]);
  assert.deepEqual([...normalized.toolNames].sort(), ["bash", "read"]);
  assert.deepEqual([...normalized.fileExtensions].sort(), [".md", ".ts"]);
});

test("checkNewToYou: present (any casing) -> false, absent -> true, order preserved, deterministic", () => {
  const vocab: HistoryVocabulary = {
    bashVerbs: ["git", "npm"],
    toolNames: ["Bash", "Read"],
    fileExtensions: [".ts", ".md"],
  };
  const candidates = [
    { kind: "bash-verb" as const, value: "GIT" },
    { kind: "bash-verb" as const, value: "kubectl" },
    { kind: "file-extension" as const, value: "rs" },
    { kind: "file-extension" as const, value: ".ts" },
    { kind: "tool-name" as const, value: "bash" },
  ];

  const first = checkNewToYou(vocab, candidates);
  const second = checkNewToYou(vocab, candidates);
  assert.deepEqual(first, second);

  assert.deepEqual(
    first.map((r) => r.isNewToYou),
    [false, true, true, false, false],
  );
  assert.deepEqual(
    first.map((r) => r.value),
    ["GIT", "kubectl", "rs", ".ts", "bash"],
  );
});

const SAMPLE_DIFF = [
  "diff --git a/src/foo.rs b/src/foo.rs",
  "index 1111111..2222222 100644",
  "--- a/src/foo.rs",
  "+++ b/src/foo.rs",
  "@@ -0,0 +1,2 @@",
  "+RUN kubectl apply -f x.yaml",
  "+this is a new helper function",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -0,0 +1,1 @@",
  "+export const bar = 1;",
].join("\n");

test("extractCandidatesFromHunks: extracts file-extensions and bash-verbs, no tool-name, no prose false positive", () => {
  const candidates = extractCandidatesFromHunks(SAMPLE_DIFF);

  assert.ok(candidates.some((c) => c.kind === "file-extension" && c.value === ".rs"));
  assert.ok(candidates.some((c) => c.kind === "file-extension" && c.value === ".ts"));
  assert.ok(candidates.some((c) => c.kind === "bash-verb" && c.value === "kubectl"));
  assert.ok(!candidates.some((c) => c.kind === "tool-name"));

  // The prose line "this is a new helper function" must not produce a bash-verb candidate.
  assert.ok(!candidates.some((c) => c.kind === "bash-verb" && c.value === "this"));

  assert.equal(candidates.length, 3, `expected exactly 3 candidates, got: ${JSON.stringify(candidates)}`);
});

test("integration: .rs and kubectl are new-to-you, others in vocab are not", () => {
  const vocab: HistoryVocabulary = {
    bashVerbs: ["git", "npm"],
    toolNames: ["Bash", "Read"],
    fileExtensions: [".ts", ".md"],
  };

  const candidates = extractCandidatesFromHunks(SAMPLE_DIFF);
  const results = checkNewToYou(vocab, candidates);

  const rsResult = results.find((r) => r.kind === "file-extension" && r.value === ".rs");
  const kubectlResult = results.find((r) => r.kind === "bash-verb" && r.value === "kubectl");
  const tsResult = results.find((r) => r.kind === "file-extension" && r.value === ".ts");

  assert.ok(rsResult);
  assert.ok(kubectlResult);
  assert.ok(tsResult);
  assert.equal(rsResult!.isNewToYou, true);
  assert.equal(kubectlResult!.isNewToYou, true);
  assert.equal(tsResult!.isNewToYou, false);
});

test("purity: new-to-you.ts source contains no fs/child_process/http/fetch I/O", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "..", "src", "new-to-you.ts"), "utf8");

  assert.ok(!/node:fs/.test(source), "must not import node:fs");
  assert.ok(!/node:child_process/.test(source), "must not import node:child_process");
  assert.ok(!/node:http/.test(source), "must not import node:http or node:https");
  assert.ok(!/\bfetch\(/.test(source), "must not call fetch");
});
