import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mineCorrections } from "../src/corrections.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("corrections: categorizes lines correctly, including multi-category and non-matching lines", async () => {
  const historyRoot = await makeTempDir("pros-miner-corrections-");
  try {
    const lines = [
      // revert
      { display: "please revert that last commit", timestamp: 1, project: "/fake/proj", sessionId: "s1" },
      // still-broken
      { display: "this is still broken after your fix", timestamp: 2, project: "/fake/proj", sessionId: "s1" },
      // no-wrong
      { display: "no, that's wrong, try again", timestamp: 3, project: "/fake/proj", sessionId: "s2" },
      // i-told-you
      { display: "i already told you to use sonnet", timestamp: 4, project: "/fake/proj", sessionId: "s2" },
      // matches both revert and no-wrong (contains "revert" and "wrong")
      { display: "please revert this, it's wrong", timestamp: 5, project: "/fake/proj", sessionId: "s3" },
      // matches none
      { display: "looks good, ship it", timestamp: 6, project: "/fake/proj", sessionId: "s3" },
    ];
    const raw = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await writeFile(path.join(historyRoot, "history.jsonl"), raw, "utf8");

    const hits = mineCorrections(historyRoot);

    assert.equal(hits.length, 6, "expected 6 total hits (one multi-category line producing 2)");

    const byLineIndex = new Map<number, string[]>();
    for (const hit of hits) {
      const bucket = byLineIndex.get(hit.lineIndex) ?? [];
      bucket.push(hit.category);
      byLineIndex.set(hit.lineIndex, bucket);
    }

    assert.deepEqual(byLineIndex.get(0), ["revert"]);
    assert.deepEqual(byLineIndex.get(1), ["still-broken"]);
    assert.deepEqual(byLineIndex.get(2), ["no-wrong"]);
    assert.deepEqual(byLineIndex.get(3), ["i-told-you"]);
    assert.deepEqual(new Set(byLineIndex.get(4)), new Set(["revert", "no-wrong"]));
    assert.equal(byLineIndex.get(5), undefined, "line matching no category must produce no hits");

    for (const hit of hits) {
      assert.equal(typeof hit.sessionId, "string");
      assert.equal(typeof hit.project, "string");
      assert.equal(typeof hit.timestampMs, "number");
      assert.equal(typeof hit.quote, "string");
    }
  } finally {
    await cleanup(historyRoot);
  }
});

test("corrections: returns empty array when history.jsonl does not exist", async () => {
  const historyRoot = await makeTempDir("pros-miner-corrections-missing-");
  try {
    const hits = mineCorrections(historyRoot);
    assert.deepEqual(hits, []);
  } finally {
    await cleanup(historyRoot);
  }
});
