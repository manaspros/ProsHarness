import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinearSource } from "../src/sources/linear.js";
import { SlackSource } from "../src/sources/slack.js";
import { GranolaSource } from "../src/sources/granola.js";
import { SweepSource } from "../src/sources/sweep.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

test("LinearSource parses fixture into well-formed Signal[]", async () => {
  const source = new LinearSource({ fixturePath: path.join(FIXTURES, "linear-issues.json") });
  const signals = await source.fetchSignals();
  assert.equal(signals.length, 2);
  for (const s of signals) {
    assert.equal(s.sourceId, "linear");
    assert.equal(s.kind, "issue");
    assert.ok(s.externalId);
    assert.ok(s.title);
    assert.ok(s.raisedAt);
  }
  assert.equal(signals[0].externalId, "lin_001");
  assert.equal(signals[0].title, "Dashboard chart flickers on refresh");
});

test("SlackSource parses fixture into well-formed Signal[]", async () => {
  const source = new SlackSource({ fixturePath: path.join(FIXTURES, "slack-messages.json") });
  const signals = await source.fetchSignals();
  assert.equal(signals.length, 2);
  for (const s of signals) {
    assert.equal(s.sourceId, "slack");
    assert.equal(s.kind, "message");
    assert.ok(s.externalId);
  }
  assert.equal(signals[0].externalId, "1755000000");
  assert.match(signals[0].body, /worktree allocator/);
});

test("GranolaSource emits one Signal per action item, dedup-independent externalIds", async () => {
  const source = new GranolaSource({ fixturePath: path.join(FIXTURES, "granola-notes.json") });
  const signals = await source.fetchSignals();
  // note gr_001 has 2 action items, gr_002 has 1 => 3 total signals
  assert.equal(signals.length, 3);
  for (const s of signals) {
    assert.equal(s.sourceId, "granola");
    assert.equal(s.kind, "action-item");
  }
  assert.equal(signals[0].externalId, "gr_001:0");
  assert.equal(signals[1].externalId, "gr_001:1");
  assert.equal(signals[2].externalId, "gr_002:0");
});

test("SweepSource scans a planted-TODO tmp directory and finds correct evidence file:line", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "pros-triggers-sweep-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "foo.ts"),
      ["export const x = 1;", "// TODO: handle the null case here", "export const y = 2;"].join("\n"),
    );
    await mkdir(path.join(repoRoot, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(repoRoot, "node_modules", "ignored", "bar.ts"), "// TODO: should never be seen");

    const source = new SweepSource({ repoRoot });
    const signals = await source.fetchSignals();
    assert.equal(signals.length, 1);
    const [signal] = signals;
    assert.equal(signal.sourceId, "sweep");
    assert.equal(signal.kind, "todo");
    assert.ok(signal.evidence);
    assert.equal(signal.evidence?.file, path.join("src", "foo.ts"));
    assert.equal(signal.evidence?.line, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("SweepSource externalId is stable across line-number shifts (hashes text, not line)", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "pros-triggers-sweep-stable-"));
  try {
    await writeFile(path.join(repoRoot, "a.ts"), "// TODO: fix me\n");
    const before = await new SweepSource({ repoRoot }).fetchSignals();

    await writeFile(path.join(repoRoot, "a.ts"), "\n\n// TODO: fix me\n");
    const after = await new SweepSource({ repoRoot }).fetchSignals();

    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.equal(before[0].externalId, after[0].externalId);
    assert.notEqual(before[0].evidence?.line, after[0].evidence?.line);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("Adapters with no fixture path and no real credentials return [] (graceful not-configured)", async () => {
  assert.deepEqual(await new LinearSource({}).fetchSignals(), []);
  assert.deepEqual(await new SlackSource({}).fetchSignals(), []);
  assert.deepEqual(await new GranolaSource({}).fetchSignals(), []);
});

test("Malformed fixture JSON throws a clear error rather than silently returning []", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-triggers-badfixture-"));
  try {
    const badPath = path.join(dir, "bad.json");
    await writeFile(badPath, "{ not valid json");
    await assert.rejects(() => new LinearSource({ fixturePath: badPath }).fetchSignals(), /malformed JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
