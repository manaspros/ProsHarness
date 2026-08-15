import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeLine } from "../src/claude.js";
import { parseCodexLine } from "../src/codex.js";
import type { ParseStatus } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

const KNOWN_CLAUDE_TYPES = new Set(["rate_limit_event", "system", "assistant", "user", "result"]);
const KNOWN_CODEX_TYPES = new Set(["thread.started", "turn.started", "item.completed", "turn.completed"]);

function fixtureFiles(provider: "claude" | "codex"): string[] {
  const dir = join(FIXTURES_DIR, provider);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => join(dir, f));
}

function linesOf(path: string): string[] {
  const contents = readFileSync(path, "utf8");
  // Fixtures are committed with a trailing newline; drop any trailing empty
  // element from the final split without discarding genuinely blank lines
  // in the middle of the file.
  const lines = contents.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

test("claude fixtures: every line parses without throwing, seq is in order, known types are ok", () => {
  const files = fixtureFiles("claude");
  assert.ok(files.length >= 2, "expected at least 2 claude fixtures");

  for (const file of files) {
    const lines = linesOf(file);
    assert.ok(lines.length > 0, `${file} should not be empty`);

    lines.forEach((raw, i) => {
      const parsed = parseClaudeLine(raw, i);
      assert.equal(parsed.provider, "claude");
      assert.equal(parsed.seq, i);
      assert.equal(parsed.raw, raw);
      assert.notEqual(parsed.parseStatus, "malformed", `real fixture line should be valid JSON: ${file}:${i}`);
      if (parsed.type !== undefined && KNOWN_CLAUDE_TYPES.has(parsed.type)) {
        assert.equal(parsed.parseStatus, "ok", `expected ok for known type ${parsed.type} in ${file}:${i}`);
      }
    });
  }
});

test("codex fixtures: every line parses without throwing, seq is in order, known types are ok", () => {
  const files = fixtureFiles("codex");
  assert.ok(files.length >= 2, "expected at least 2 codex fixtures");

  let sawUnknownType = false;

  for (const file of files) {
    const lines = linesOf(file);
    assert.ok(lines.length > 0, `${file} should not be empty`);

    lines.forEach((raw, i) => {
      const parsed = parseCodexLine(raw, i);
      assert.equal(parsed.provider, "codex");
      assert.equal(parsed.seq, i);
      assert.equal(parsed.raw, raw);
      assert.notEqual(parsed.parseStatus, "malformed", `real fixture line should be valid JSON: ${file}:${i}`);
      if (parsed.type !== undefined && KNOWN_CODEX_TYPES.has(parsed.type)) {
        assert.equal(parsed.parseStatus, "ok", `expected ok for known type ${parsed.type} in ${file}:${i}`);
      }
      if (parsed.parseStatus === "unknown_type") sawUnknownType = true;
    });
  }

  // The recorded codex-tool-call.ndjson fixture organically contains an
  // `item.started` event, which is NOT in KNOWN_CODEX_TYPES. This confirms
  // the tolerant-parsing invariant is exercised by real CLI output, not just
  // synthetic cases below.
  assert.ok(sawUnknownType, "expected at least one organically-unknown codex type in fixtures (e.g. item.started)");
});

test("synthetic unknown_type line never throws and preserves raw", () => {
  const raw = '{"type":"some_totally_new_event_type","foo":"bar"}';
  for (const parseLine of [parseClaudeLine, parseCodexLine]) {
    const parsed = parseLine(raw, 42);
    assert.equal(parsed.parseStatus satisfies ParseStatus, "unknown_type");
    assert.equal(parsed.raw, raw);
    assert.equal(parsed.seq, 42);
    assert.equal(parsed.type, "some_totally_new_event_type");
    assert.deepEqual(parsed.data, { type: "some_totally_new_event_type", foo: "bar" });
  }
});

test("synthetic malformed line never throws and preserves raw, no data", () => {
  const raw = "{this is not valid json at all";
  for (const parseLine of [parseClaudeLine, parseCodexLine]) {
    const parsed = parseLine(raw, 7);
    assert.equal(parsed.parseStatus satisfies ParseStatus, "malformed");
    assert.equal(parsed.raw, raw);
    assert.equal(parsed.seq, 7);
    assert.equal(parsed.data, undefined);
    assert.equal(parsed.type, undefined);
  }
});

test("line with no type field parses as unknown_type but keeps data", () => {
  const raw = '{"foo":"bar"}';
  for (const parseLine of [parseClaudeLine, parseCodexLine]) {
    const parsed = parseLine(raw, 3);
    assert.equal(parsed.parseStatus satisfies ParseStatus, "unknown_type");
    assert.equal(parsed.type, undefined);
    assert.deepEqual(parsed.data, { foo: "bar" });
  }
});
