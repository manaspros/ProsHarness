import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { POST } from "../app/api/new/scan/route.js";

// Only the sweep path is exercised here for real: it's local-only (a plain
// filesystem grep), so running it in a test is exactly as safe as the
// production code path -- no fixture/injection needed. The linear/slack/
// granola paths are deliberately NOT exercised through this route in any
// test: the route constructs `new LinearSource({})` etc. with no
// mcpSession/fixturePath injection point, matching production exactly, so
// there is no way to call them here without either spawning a real `claude`
// subprocess (forbidden) or changing the route's production code just to
// make it testable (out of scope for this fix). Their MCP-unavailable throw
// behavior is already covered, with an injected fake ModelSession, by
// packages/triggers/test/{sources,runner}.test.ts.

function fakeRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

test("scan: sweep finds a TODO with file:line evidence in a real temp repo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-scan-sweep-"));
  try {
    await writeFile(path.join(dir, "notes.ts"), "// TODO: fix this later\nconst x = 1;\n");
    const res = await POST(fakeRequest({ repoRoot: dir, source: "sweep" }));
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.signals.length, 1);
    assert.equal(data.signals[0].sourceId, "sweep");
    assert.equal(data.signals[0].evidence.file, "notes.ts");
    assert.equal(data.signals[0].evidence.line, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan: sweep over a repo tree with no TODO/FIXME/XXX returns ok:true with an empty array, not an error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-scan-sweep-empty-"));
  try {
    await writeFile(path.join(dir, "notes.ts"), "const x = 1;\n");
    const res = await POST(fakeRequest({ repoRoot: dir, source: "sweep" }));
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.signals, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan: missing repoRoot for a sweep scan is a 400, not a silent failure", async () => {
  const res = await POST(fakeRequest({ source: "sweep" }));
  assert.equal(res.status, 400);
});

test("scan: unknown source is a 400", async () => {
  const res = await POST(fakeRequest({ repoRoot: "/tmp", source: "carrier-pigeon" }));
  assert.equal(res.status, 400);
});
