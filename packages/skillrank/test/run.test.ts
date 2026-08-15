import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSkillrank, writeSkillrankOutput } from "../src/run.js";

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "skillrank-test-"));
}

test("runSkillrank + writeSkillrankOutput end-to-end produces correctly shaped skill-proposals.json", () => {
  const dir = tmpDir();
  const lockFilePath = path.join(dir, "skill-registry-lock.json");
  const minerOutDir = path.join(dir, "miner-out");
  const outDir = path.join(dir, "skillrank-out");

  writeFileSync(
    lockFilePath,
    JSON.stringify({
      version: 1,
      skills: [{ slug: "obra/brainstorming" }],
    }),
    "utf8",
  );

  mkdirSync(minerOutDir, { recursive: true });
  writeFileSync(
    path.join(minerOutDir, "history-vocabulary.json"),
    JSON.stringify({
      generatedAt: "2026-08-14T00:00:00Z",
      bashVerbs: ["git", "batch"],
      toolNames: ["Bash"],
      fileExtensions: [".ts"],
    }),
    "utf8",
  );

  const file = runSkillrank({ lockFilePath, minerOutDir, outDir });
  writeSkillrankOutput(file, outDir);

  const written = JSON.parse(readFileSync(path.join(outDir, "skill-proposals.json"), "utf8"));

  assert.equal(typeof written.generatedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(written.generatedAt)));
  assert.deepEqual(written.installedSlugs, ["obra/brainstorming"]);
  assert.ok(Array.isArray(written.proposals));
  assert.ok(written.proposals.length > 0);

  // Sorted descending by score.
  for (let i = 1; i < written.proposals.length; i++) {
    assert.ok(written.proposals[i - 1].score >= written.proposals[i].score);
  }

  // Excludes already-installed slug.
  assert.ok(!written.proposals.some((p: { slug: string }) => p.slug === "obra/brainstorming"));

  // Every proposal has the status invariant.
  for (const p of written.proposals) {
    assert.equal(p.status, "proposed");
  }

  rmSync(dir, { recursive: true, force: true });
});
