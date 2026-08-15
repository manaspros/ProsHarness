import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readInstalledSlugs, readHistoryVocabulary } from "../src/signals.js";

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "skillrank-test-"));
}

test("readInstalledSlugs parses a real-shaped lock file fixture", () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, "skill-registry-lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      skills: [
        {
          slug: "obra/brainstorming",
          registryRef:
            "obra/brainstorming@sha256:9348e40f0a335da04d29dfd6ebf93a6e6b05e3a4aa502f68a341d24c15c9111d",
          sourceType: "github",
          source: "https://github.com/obra/superpowers/tree/main/skills/brainstorming",
          skillPath: ".claude/skills/skillrank-brainstorming/SKILL.md",
          surface: ".claude/skills",
          computedHash: "sha256:9348e40f0a335da04d29dfd6ebf93a6e6b05e3a4aa502f68a341d24c15c9111d",
          localHash: "sha256:ec3d096a72460582886cfadd998120aa9767e2e9a06bf7985fd1e42c0834a16f",
          pinnedCommit: "44c9b2d6e889982ac18c27d05a19fefe335194e1",
          installedAt: "2026-08-14T13:27:23Z",
        },
      ],
    }),
    "utf8",
  );

  assert.deepEqual(readInstalledSlugs(lockPath), ["obra/brainstorming"]);
  rmSync(dir, { recursive: true, force: true });
});

test("readInstalledSlugs tolerates a missing file", () => {
  assert.deepEqual(readInstalledSlugs("/nonexistent/does-not-exist.json"), []);
});

test("readInstalledSlugs tolerates a malformed file", () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, "bad.json");
  writeFileSync(lockPath, "{ not valid json", "utf8");
  assert.deepEqual(readInstalledSlugs(lockPath), []);
  rmSync(dir, { recursive: true, force: true });
});

test("readInstalledSlugs tolerates unexpected shape", () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, "shapeless.json");
  writeFileSync(lockPath, JSON.stringify({ hello: "world" }), "utf8");
  assert.deepEqual(readInstalledSlugs(lockPath), []);
  rmSync(dir, { recursive: true, force: true });
});

test("readHistoryVocabulary parses a history-vocabulary.json-shaped fixture", () => {
  const dir = tmpDir();
  writeFileSync(
    path.join(dir, "history-vocabulary.json"),
    JSON.stringify({
      generatedAt: "2026-08-14T00:00:00Z",
      bashVerbs: ["git", "worktree", "pnpm"],
      toolNames: ["Bash", "Edit", "Read"],
      fileExtensions: [".ts", ".md"],
    }),
    "utf8",
  );

  const vocab = readHistoryVocabulary(dir);
  assert.deepEqual(vocab, {
    bashVerbs: ["git", "worktree", "pnpm"],
    toolNames: ["Bash", "Edit", "Read"],
    fileExtensions: [".ts", ".md"],
  });
  rmSync(dir, { recursive: true, force: true });
});

test("readHistoryVocabulary tolerates a missing directory/file", () => {
  const vocab = readHistoryVocabulary("/nonexistent/miner-out-dir");
  assert.deepEqual(vocab, { bashVerbs: [], toolNames: [], fileExtensions: [] });
});

test("readHistoryVocabulary tolerates a malformed file", () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "history-vocabulary.json"), "not json at all", "utf8");
  const vocab = readHistoryVocabulary(dir);
  assert.deepEqual(vocab, { bashVerbs: [], toolNames: [], fileExtensions: [] });
  rmSync(dir, { recursive: true, force: true });
});
