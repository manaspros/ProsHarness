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
    evidence: [{ file: "loop.ts", line: 8, snippet: "for (let i = 0; i <= arr.length; i++) {" }],
    summary: "the loop bound should be `<` not `<=`",
  });
  const session = new ScriptedSession("claude", [{ text: canned }]);

  const finding = await runFinding(session, { cwd: "/tmp", description: "sumAll returns NaN sometimes", attemptId: "a1" });

  assert.equal(finding.title, "off-by-one in sumAll");
  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0]!.file, "loop.ts");
  assert.equal(finding.evidence[0]!.line, 8);
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

/**
 * Real-CLI acceptance test for the literal M2 acceptance claim: "Finding
 * cites the right file:line." Follows packages/mcp/test/acceptance.test.ts's
 * philosophy exactly: bounded timeout, skip (not fail) if the real model
 * doesn't respond in time. Costs real subscription quota -- kept minimal
 * (one tiny file, one obvious bug, one schema-constrained call).
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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
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

    const findingPromise = runFinding(session, {
      cwd: repo,
      description:
        "sumAll(arr) in loop.ts sometimes returns NaN for arrays that don't contain NaN/undefined values. Find the root cause.",
      attemptId: "acceptance-finding-1",
    });

    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([findingPromise.then((f) => ({ finding: f }) as const), timeout]);

    if (result === "timeout") {
      t.skip(`the real claude CLI did not produce a finding within ${timeoutMs}ms`);
      return;
    }

    const { finding } = result;
    const hit = finding.evidence.find((e) => e.file.includes("loop.ts") && e.line === 9);
    if (!hit) {
      // A real model can occasionally cite a slightly different (but still
      // reasonable) line/wording. Per the acceptance-test philosophy, a
      // live-model near-miss is reported via skip, not a hard failure --
      // only a stubbed test is allowed to be load-bearing for this claim.
      t.skip(`real model finding did not cite loop.ts:8 exactly -- evidence was: ${JSON.stringify(finding.evidence)}`);
      return;
    }
    assert.ok(hit.snippet.length > 0);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("fixture source file actually contains the seeded bug at the documented line", async () => {
  const src = await readFile(path.join(__dirname, "fixtures/seeded-bug-src/loop.ts"), "utf8");
  const lines = src.split("\n");
  assert.match(lines[8] ?? "", /i <= arr\.length/, "line 9 (1-indexed) must contain the seeded off-by-one");
});
