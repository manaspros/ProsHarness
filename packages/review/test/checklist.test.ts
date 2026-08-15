import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { rankHunks } from "../src/hunks.js";
import { buildFocusChecklist } from "../src/checklist.js";
import { makeFixtureRepo } from "./helpers.js";

test("buildFocusChecklist: new fetch() call, new throw, and an untested file each produce the right checklist item", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const opts = { repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha };
    const diff = rankHunks(opts);
    const items = buildFocusChecklist(diff, opts);

    const fetchItem = items.find((i) => i.category === "new_external_call" && i.file === "packages/foo/src/net.ts");
    assert.ok(fetchItem, `expected a new_external_call item for net.ts, got: ${JSON.stringify(items)}`);
    assert.match(fetchItem!.description, /fetch\(/);

    const throwItem = items.find((i) => i.category === "error_handling_changed" && i.file === "packages/foo/src/auth.ts");
    assert.ok(throwItem, `expected an error_handling_changed item for auth.ts, got: ${JSON.stringify(items)}`);
    assert.match(throwItem!.description, /throw/);

    const untestedItem = items.find(
      (i) => i.category === "untested_branch" && i.file === "packages/foo/src/untested.ts",
    );
    assert.ok(untestedItem, `expected an untested_branch item for untested.ts, got: ${JSON.stringify(items)}`);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("buildFocusChecklist: collapsed (lockfile) hunks contribute no checklist items", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const opts = { repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha };
    const diff = rankHunks(opts);
    const items = buildFocusChecklist(diff, opts);

    assert.ok(
      items.every((i) => i.file !== "package-lock.json"),
      "package-lock.json is collapsed by default and must not produce checklist items",
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("buildFocusChecklist: deterministic order (category, then file, then line)", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const opts = { repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha };
    const diff = rankHunks(opts);
    const first = buildFocusChecklist(diff, opts);
    const second = buildFocusChecklist(diff, opts);
    assert.deepEqual(first, second);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
