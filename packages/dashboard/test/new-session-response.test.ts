import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaunchResponse, parseScanResponse, responseError } from "../lib/new-session-response.js";

test("launch response requires a non-empty runId", () => {
  assert.deepEqual(parseLaunchResponse({ ok: true, runId: "  run-123  " }), { ok: true, runId: "run-123" });
  assert.throws(() => parseLaunchResponse({ ok: true }), /invalid response/);
  assert.throws(() => parseLaunchResponse({ ok: true, runId: "   " }), /invalid response/);
});

test("launch failure response requires a useful message", () => {
  assert.deepEqual(parseLaunchResponse({ ok: false, message: "  source is not wired  " }), {
    ok: false,
    message: "source is not wired",
  });
  assert.throws(() => parseLaunchResponse({ ok: false, message: "" }), /invalid response/);
});

test("scan response requires an array of well-shaped signals", () => {
  const signal = {
    sourceId: "sweep",
    externalId: "id-1",
    kind: "todo",
    title: "TODO in notes.ts",
    body: "TODO: fix this",
    evidence: { file: "notes.ts", line: 1 },
  };
  assert.deepEqual(parseScanResponse({ ok: true, signals: [signal] }), { ok: true, signals: [signal] });
  assert.deepEqual(parseScanResponse({ ok: true, signals: [] }), { ok: true, signals: [] });
  assert.throws(() => parseScanResponse({ ok: true, signals: [{ ...signal, evidence: { file: "notes.ts", line: 0 } }] }), /invalid response/);
  assert.throws(() => parseScanResponse({ ok: true, signals: [null] }), /invalid response/);
});

test("scan failure response preserves the source message", () => {
  assert.deepEqual(parseScanResponse({ ok: false, message: "  MCP unavailable  " }), { ok: false, message: "MCP unavailable" });
  assert.equal(responseError({ error: "bad request" }, "fallback"), "bad request");
  assert.equal(responseError({ error: "" }, "fallback"), "fallback");
});
