import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { getSkillrankOutDir, loadSkillProposals } from "../lib/skillrank-data.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("getSkillrankOutDir: respects PROS_SKILLRANK_OUT when set", () => {
  const saved = process.env.PROS_SKILLRANK_OUT;
  try {
    process.env.PROS_SKILLRANK_OUT = "/tmp/some-custom-skillrank-out";
    assert.equal(getSkillrankOutDir(), "/tmp/some-custom-skillrank-out");
  } finally {
    if (saved === undefined) delete process.env.PROS_SKILLRANK_OUT;
    else process.env.PROS_SKILLRANK_OUT = saved;
  }
});

test("getSkillrankOutDir: falls back to <HOME>/.pros/skillrank when unset", () => {
  const saved = process.env.PROS_SKILLRANK_OUT;
  try {
    delete process.env.PROS_SKILLRANK_OUT;
    assert.equal(getSkillrankOutDir(), path.join(homedir(), ".pros", "skillrank"));
  } finally {
    if (saved === undefined) delete process.env.PROS_SKILLRANK_OUT;
    else process.env.PROS_SKILLRANK_OUT = saved;
  }
});

test("loadSkillProposals: missing file -> unavailable, empty proposals", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    const result = loadSkillProposals(dir);
    assert.deepEqual(result, { available: false, installedSlugs: [], proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: valid file parses correctly", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    const file = {
      generatedAt: "2026-08-15T00:00:00.000Z",
      installedSlugs: ["obra/foo"],
      proposals: [
        {
          id: "obra-using-git-worktrees",
          slug: "obra/using-git-worktrees",
          name: "Using git worktrees",
          reason: "matches your frequent use of: git, worktree, parallel (12 sessions)",
          matchedKeywords: ["git", "worktree", "parallel"],
          score: 0.87,
          status: "proposed",
        },
      ],
    };
    await writeFile(path.join(dir, "skill-proposals.json"), JSON.stringify(file));

    const result = loadSkillProposals(dir);
    assert.equal(result.available, true);
    assert.equal(result.generatedAt, "2026-08-15T00:00:00.000Z");
    assert.deepEqual(result.installedSlugs, ["obra/foo"]);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0]!.slug, "obra/using-git-worktrees");
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: malformed JSON -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    await writeFile(path.join(dir, "skill-proposals.json"), "{ this is not valid json ][");
    const result = loadSkillProposals(dir);
    assert.deepEqual(result, { available: false, installedSlugs: [], proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: valid JSON but wrong shape (proposals not an array) -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    await writeFile(path.join(dir, "skill-proposals.json"), JSON.stringify({ generatedAt: "x", proposals: "nope" }));
    const result = loadSkillProposals(dir);
    assert.deepEqual(result, { available: false, installedSlugs: [], proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: missing proposals key entirely -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    await writeFile(path.join(dir, "skill-proposals.json"), JSON.stringify({ generatedAt: "x" }));
    const result = loadSkillProposals(dir);
    assert.deepEqual(result, { available: false, installedSlugs: [], proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: one malformed proposal entry is dropped, valid ones survive", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    const file = {
      generatedAt: "2026-08-15T00:00:00.000Z",
      installedSlugs: [],
      proposals: [
        {
          id: "good-one",
          slug: "obra/good-one",
          name: "Good one",
          reason: "reason",
          matchedKeywords: ["a"],
          score: 1,
          status: "proposed",
        },
        {
          id: "bad-one",
          // missing slug, name, reason, matchedKeywords, score
        },
      ],
    };
    await writeFile(path.join(dir, "skill-proposals.json"), JSON.stringify(file));

    const result = loadSkillProposals(dir);
    assert.equal(result.available, true);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0]!.id, "good-one");
  } finally {
    await cleanup(dir);
  }
});

test("loadSkillProposals: installedSlugs falls back to [] if wrong shape", async () => {
  const dir = await makeTempDir("pros-dash-skillrank-");
  try {
    await writeFile(
      path.join(dir, "skill-proposals.json"),
      JSON.stringify({ generatedAt: "x", installedSlugs: "not-an-array", proposals: [] }),
    );
    const result = loadSkillProposals(dir);
    assert.equal(result.available, true);
    assert.deepEqual(result.installedSlugs, []);
  } finally {
    await cleanup(dir);
  }
});

test("skills page: never contains any interactive/mutating constructs (static inspection)", async () => {
  const pagePath = path.join(import.meta.dirname, "..", "app", "skills", "page.tsx");
  const source = await readFile(pagePath, "utf8");

  const forbidden = ['"use client"', "<form", "onClick", "onSubmit", "fetch(", 'method: "POST"'];
  for (const needle of forbidden) {
    assert.ok(!source.includes(needle), `page.tsx must not contain ${JSON.stringify(needle)}`);
  }
});
