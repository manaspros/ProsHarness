import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelSession, ModelRunOptions, ModelRunResult } from "@pros/plan";
import { LinearSource } from "../src/sources/linear.js";
import { SlackSource } from "../src/sources/slack.js";
import { GranolaSource } from "../src/sources/granola.js";
import { SweepSource } from "../src/sources/sweep.js";

/**
 * Minimal fake ModelSession mirroring packages/implement/test/e2e-m4.test.ts's
 * FakeSession -- returns a canned response (or throws) instead of ever
 * spawning a real `claude` binary. Used to drive each source's MCP path in
 * tests without touching real MCP servers or the network.
 */
class FakeMcpSession implements ModelSession {
  readonly provider = "claude" as const;
  constructor(private readonly behavior: { text?: string; error?: Error }) {}
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    if (this.behavior.error) throw this.behavior.error;
    return { text: this.behavior.text ?? "[]", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** Temporarily swaps globalThis.fetch, restoring it afterward -- for testing each source's fetchFromApi fallback without a real network call. */
async function withFakeFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

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

test("LinearSource MCP path: well-formed JSON from a fake session maps to well-formed Signal[]", async () => {
  const fixtureJson = JSON.stringify([
    { id: "lin_mcp_1", identifier: "ENG-1", title: "MCP-sourced issue", description: "desc", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const source = new LinearSource({ mcpSession: new FakeMcpSession({ text: fixtureJson }) });
  const signals = await source.fetchSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].sourceId, "linear");
  assert.equal(signals[0].kind, "issue");
  assert.equal(signals[0].externalId, "lin_mcp_1");
  assert.equal(signals[0].title, "MCP-sourced issue");
});

test("SlackSource MCP path: well-formed JSON from a fake session maps to well-formed Signal[]", async () => {
  const fixtureJson = JSON.stringify([{ ts: "1755000000", channel: "eng", user: "u1", text: "hello from MCP" }]);
  const source = new SlackSource({ mcpSession: new FakeMcpSession({ text: fixtureJson }) });
  const signals = await source.fetchSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].sourceId, "slack");
  assert.equal(signals[0].kind, "message");
  assert.match(signals[0].body, /hello from MCP/);
});

test("GranolaSource MCP path: well-formed JSON from a fake session maps to well-formed Signal[]", async () => {
  const fixtureJson = JSON.stringify([
    { id: "gr_mcp_1", title: "MCP meeting", actionItems: ["do a thing", "do another thing"], createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const source = new GranolaSource({ mcpSession: new FakeMcpSession({ text: fixtureJson }) });
  const signals = await source.fetchSignals();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].sourceId, "granola");
  assert.equal(signals[0].externalId, "gr_mcp_1:0");
  assert.equal(signals[1].externalId, "gr_mcp_1:1");
});

test("LinearSource: MCP failure with an apiKey-shaped fallback configured falls back to fetchFromApi", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        data: { issues: { nodes: [{ id: "lin_api_1", identifier: "ENG-2", title: "API-sourced issue", updatedAt: "2026-01-02T00:00:00.000Z" }] } },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  await withFakeFetch(fakeFetch, async () => {
    const source = new LinearSource({
      apiUrl: "https://example.invalid/graphql",
      apiKey: "key",
      mcpSession: new FakeMcpSession({ error: new Error("mcp down") }),
    });
    const signals = await source.fetchSignals();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].externalId, "lin_api_1");
  });
});

test("SlackSource: MCP failure with an apiKey-shaped fallback configured falls back to fetchFromApi", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: true, messages: [{ ts: "1755000001", user: "u2", text: "api fallback message" }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  await withFakeFetch(fakeFetch, async () => {
    const source = new SlackSource({
      botToken: "tok",
      channel: "C123",
      mcpSession: new FakeMcpSession({ error: new Error("mcp down") }),
    });
    const signals = await source.fetchSignals();
    assert.equal(signals.length, 1);
    assert.match(signals[0].body, /api fallback message/);
  });
});

test("GranolaSource: MCP failure with an apiKey-shaped fallback configured falls back to fetchFromApi", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ notes: [{ id: "gr_api_1", title: "API note", actionItems: ["api action"], createdAt: "2026-01-03T00:00:00.000Z" }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  await withFakeFetch(fakeFetch, async () => {
    const source = new GranolaSource({
      apiKey: "key",
      mcpSession: new FakeMcpSession({ error: new Error("mcp down") }),
    });
    const signals = await source.fetchSignals();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].externalId, "gr_api_1:0");
  });
});

test("Sources with no fixture, no MCP session available, and no API-key fallback REJECT with a clear error (never silently [])", async () => {
  await assert.rejects(
    () => new LinearSource({ mcpSession: new FakeMcpSession({ error: new Error("mcp down") }) }).fetchSignals(),
    /MCP path unavailable/,
  );
  await assert.rejects(
    () => new SlackSource({ mcpSession: new FakeMcpSession({ error: new Error("mcp down") }) }).fetchSignals(),
    /MCP path unavailable/,
  );
  await assert.rejects(
    () => new GranolaSource({ mcpSession: new FakeMcpSession({ error: new Error("mcp down") }) }).fetchSignals(),
    /MCP path unavailable/,
  );
});

test("MCP path times out when a slow fake session exceeds mcpTimeoutMs, and rejects (no fallback configured)", async () => {
  class SlowSession implements ModelSession {
    readonly provider = "claude" as const;
    async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { text: "[]", usage: { inputTokens: 1, outputTokens: 1 } };
    }
  }
  await assert.rejects(
    () => new LinearSource({ mcpSession: new SlowSession(), mcpTimeoutMs: 20 }).fetchSignals(),
    /MCP path unavailable/,
  );
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
