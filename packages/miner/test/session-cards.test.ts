import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSessionCards } from "../src/session-cards.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("session-cards: extracts all fields correctly, tolerating malformed/unknown rows", async () => {
  const historyRoot = await makeTempDir("pros-miner-cards-");
  try {
    const bucketDir = path.join(historyRoot, "projects", "-fake-projects-widget");
    await mkdir(bucketDir, { recursive: true });

    const sessionId = "sess-fake-0001";
    const rows: unknown[] = [
      {
        type: "user",
        message: { role: "user", content: "fix the login bug, ticket ABC-123" },
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/fake/projects/widget",
        sessionId,
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "let's look" },
            { type: "tool_use", name: "Bash", input: { command: "git status" } },
          ],
        },
        uuid: "a1",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git log" } }] },
        uuid: "a2",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
        uuid: "a3",
        sessionId,
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "scoped-fixer", description: "fix it" } }],
        },
        uuid: "a4",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "code-review" } }] },
        uuid: "a5",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "ExitPlanMode", input: {} }] },
        uuid: "a6",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: "/fake/projects/widget/a.ts" } }] },
        uuid: "a7",
        sessionId,
      },
      // this weird/unknown type row must be tolerated
      { type: "queue-operation", foo: "bar", sessionId },
      // pr-link row
      {
        type: "pr-link",
        sessionId,
        prNumber: 42,
        prUrl: "https://github.com/fake-org/widget/pull/42",
        prRepository: "fake-org/widget",
        timestamp: "2026-01-01T00:10:00.000Z",
      },
    ];

    const raw = rows.map((r) => JSON.stringify(r)).join("\n") + "\nthis is not valid json {\n";
    await writeFile(path.join(bucketDir, `${sessionId}.jsonl`), raw, "utf8");

    const cards = buildSessionCards(historyRoot);
    assert.equal(cards.length, 1, "expected exactly 1 session card");
    const card = cards[0];

    assert.equal(card.sessionId, sessionId);
    assert.equal(card.openingPrompt, "fix the login bug, ticket ABC-123");
    assert.equal(card.turnCount, 1);
    assert.equal(card.bashVerbs.git, 2);
    assert.equal(card.bashVerbs.npm, 1);
    assert.deepEqual(card.subagentTypes, ["scoped-fixer"]);
    assert.deepEqual(card.skillsInvoked, ["code-review"]);
    assert.equal(card.hasPlanArtifact, true);
    assert.deepEqual(card.filesWritten, ["/fake/projects/widget/a.ts"]);
    assert.equal(card.hasPrLink, true);
    assert.deepEqual(card.prUrls, ["https://github.com/fake-org/widget/pull/42"]);
    assert.equal(card.toolCounts.Bash, 3);
    assert.equal(card.toolCounts.Agent, 1);
    assert.equal(card.toolCounts.Skill, 1);
    assert.equal(card.toolCounts.ExitPlanMode, 1);
    assert.equal(card.toolCounts.Write, 1);
  } finally {
    await cleanup(historyRoot);
  }
});

test("session-cards: files under a nested subagents/ directory are NOT counted as top-level sessions", async () => {
  const historyRoot = await makeTempDir("pros-miner-cards-nested-");
  try {
    const bucketDir = path.join(historyRoot, "projects", "-fake-projects-widget");
    const subagentsDir = path.join(bucketDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    const topSessionId = "sess-top-0001";
    await writeFile(
      path.join(bucketDir, `${topSessionId}.jsonl`),
      JSON.stringify({ type: "user", message: { content: "top level session" }, sessionId: topSessionId }) + "\n",
      "utf8",
    );

    const nestedSessionId = "sess-nested-0001";
    await writeFile(
      path.join(subagentsDir, `${nestedSessionId}.jsonl`),
      JSON.stringify({ type: "user", message: { content: "nested subagent transcript" }, sessionId: nestedSessionId }) + "\n",
      "utf8",
    );

    const cards = buildSessionCards(historyRoot);
    assert.equal(cards.length, 1, "only the top-level session should be counted");
    assert.equal(cards[0].sessionId, topSessionId);
  } finally {
    await cleanup(historyRoot);
  }
});
