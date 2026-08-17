import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runFinding } from "../src/finding.js";
import { RealClaudeSession, toCodexStrictSchema } from "../src/real-sessions.js";
import { ScriptedSession } from "./helpers.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("runFinding parses a well-formed scripted finding", async () => {
  const canned = JSON.stringify({
    title: "off-by-one in sumAll",
    evidence: [{ file: "loop.ts", line: 9, snippet: "for (let i = 0; i <= arr.length; i++) {" }],
    summary: "the loop bound should be `<` not `<=`",
  });
  const session = new ScriptedSession("claude", [{ text: canned }]);
  const repo = path.join(__dirname, "fixtures/seeded-bug-src");

  const finding = await runFinding(session, { cwd: repo, description: "sumAll returns NaN sometimes", attemptId: "a1" });

  assert.equal(finding.title, "off-by-one in sumAll");
  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0]!.file, "loop.ts");
  assert.equal(finding.evidence[0]!.line, 9);
  assert.ok(finding.findingId.length > 0);
});

test("toCodexStrictSchema adds strict object keywords without mutating the shared schema", () => {
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
      nested: { type: "object", properties: { ok: { type: "boolean" } } },
    },
    required: ["answer"],
  };

  const normalized = toCodexStrictSchema(schema) as {
    additionalProperties: boolean;
    required: string[];
    properties: { nested: { additionalProperties: boolean; required: string[] } };
  };

  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.required, ["answer", "nested"]);
  assert.equal(normalized.properties.nested.additionalProperties, false);
  assert.deepEqual(normalized.properties.nested.required, ["ok"]);
  assert.equal("additionalProperties" in schema, false);
});

test("runFinding throws a clear, specific error on malformed model output rather than swallowing it", async () => {
  const session = new ScriptedSession("claude", [{ text: JSON.stringify({ title: "no evidence field here", summary: "x" }) }]);
  await assert.rejects(
    () => runFinding(session, { cwd: "/tmp", description: "whatever", attemptId: "a1" }),
    /evidence/,
  );
});

test("runFinding throws on non-JSON model output", async () => {
  const session = new ScriptedSession("claude", [{ text: "this is not json at all" }]);
  await assert.rejects(() => runFinding(session, { cwd: "/tmp", description: "whatever", attemptId: "a1" }), /not valid JSON/);
});

test("runFinding rejects evidence that is missing, outside the repo, or does not match the cited line", async () => {
  const repo = path.join(__dirname, "fixtures/seeded-bug-src");
  const cases = [
    {
      label: "missing file",
      evidence: [{ file: "missing.ts", line: 1, snippet: "anything" }],
      error: /does not exist/,
    },
    {
      label: "outside repo",
      evidence: [{ file: "../../finding.test.ts", line: 1, snippet: "import" }],
      error: /outside repository/,
    },
    {
      label: "wrong line",
      evidence: [{ file: "loop.ts", line: 8, snippet: "for (let i = 0; i <= arr.length; i++) {" }],
      error: /does not occur/,
    },
  ];

  for (const item of cases) {
    const session = new ScriptedSession("claude", [
      {
        text: JSON.stringify({ title: item.label, evidence: item.evidence, summary: "summary" }),
      },
    ]);
    await assert.rejects(
      () => runFinding(session, { cwd: repo, description: "find the bug", attemptId: `evidence-${item.label}` }),
      item.error,
    );
  }
});

/**
 * Real-CLI acceptance test for the literal M2 acceptance claim: "Finding
 * cites the right file:line." Follows packages/mcp/test/acceptance.test.ts's
 * philosophy exactly: bounded timeout. The only permitted skip is when the
 * real Claude CLI is unavailable; an installed provider that times out or
 * returns invalid evidence must fail this acceptance. Costs real subscription
 * quota -- kept minimal (one tiny file, one obvious bug, one schema-constrained
 * call).
 */
test("acceptance: real claude CLI finds the seeded off-by-one and cites the right file:line", async (t) => {
  const hasClaudeCli = await execFileAsync("which", ["claude"]).then(
    () => true,
    () => false,
  );
  if (!hasClaudeCli) {
    t.skip("claude CLI not found on PATH");
    return;
  }

  const repo = await mkdtemp(path.join(tmpdir(), "pros-plan-seeded-bug-"));
  try {
    const fixtureSrc = path.join(__dirname, "fixtures/seeded-bug-src");
    await cp(fixtureSrc, repo, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "seed bug fixture"], { cwd: repo });

    const session = new RealClaudeSession();
    const timeoutMs = 60_000;

    const finding = await runFinding(session, {
      cwd: repo,
      description:
        "sumAll(arr) in loop.ts sometimes returns NaN for arrays that don't contain NaN/undefined values. Find the root cause.",
      attemptId: "acceptance-finding-1",
      timeoutMs,
    });
    const hit = finding.evidence.find((e) => e.file.includes("loop.ts") && e.line === 9);
    assert.ok(hit, `real model finding did not cite loop.ts:9 -- evidence was: ${JSON.stringify(finding.evidence)}`);
    assert.ok(hit.snippet.length > 0);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("fixture source file actually contains the seeded bug at the documented line", async () => {
  const src = await readFile(path.join(__dirname, "fixtures/seeded-bug-src/loop.ts"), "utf8");
  const lines = src.split("\n");
  assert.match(lines[8] ?? "", /i <= arr\.length/, "line 9 (1-indexed) must contain the seeded off-by-one");
});
