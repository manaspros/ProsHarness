import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentBrief, loadAgentBriefByName, loadSkillBrief } from "../src/load-brief.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

test("loadAgentBrief: implementer.md has model sonnet, tools include Write, body mentions worktree", async () => {
  const brief = await loadAgentBrief(path.join(repoRoot, ".claude/agents/implementer.md"));
  assert.equal(brief.name, "implementer");
  assert.equal(brief.model, "sonnet");
  assert.ok(brief.tools.includes("Write"), `expected tools to include "Write", got ${JSON.stringify(brief.tools)}`);
  assert.ok(brief.systemPrompt.length > 0, "systemPrompt should be non-empty");
  assert.match(brief.systemPrompt.toLowerCase(), /worktree/);
});

test("loadAgentBrief: scoped-fixer.md has tools including Edit, body mentions allowlist", async () => {
  const brief = await loadAgentBrief(path.join(repoRoot, ".claude/agents/scoped-fixer.md"));
  assert.equal(brief.name, "scoped-fixer");
  assert.ok(brief.tools.includes("Edit"), `expected tools to include "Edit", got ${JSON.stringify(brief.tools)}`);
  assert.match(brief.systemPrompt.toLowerCase(), /allowlist/);
});

test("loadAgentBrief: finder.md tools do not include Write or Edit", async () => {
  const brief = await loadAgentBrief(path.join(repoRoot, ".claude/agents/finder.md"));
  assert.equal(brief.name, "finder");
  assert.ok(!brief.tools.includes("Write"), "finder must not have Write");
  assert.ok(!brief.tools.includes("Edit"), "finder must not have Edit");
});

test("loadAgentBriefByName resolves .claude/agents/<name>.md given a repoRoot", async () => {
  const brief = await loadAgentBriefByName(repoRoot, "implementer");
  assert.equal(brief.name, "implementer");
  assert.equal(brief.model, "sonnet");
});

test("loadSkillBrief: review/SKILL.md body mentions codex and ultrareview", async () => {
  const brief = await loadSkillBrief(path.join(repoRoot, ".claude/skills/review/SKILL.md"));
  assert.equal(brief.name, "review");
  assert.ok(brief.body.length > 0, "body should be non-empty");
  assert.match(brief.body.toLowerCase(), /codex/);
  assert.match(brief.body.toLowerCase(), /ultrareview/);
});

test("loadAgentBrief throws a clear error for a file with no frontmatter", async () => {
  await assert.rejects(
    () => loadAgentBrief(path.join(__dirname, "fixtures/no-frontmatter.md")),
    /frontmatter/i,
  );
});

test("loadSkillBrief throws a clear error for a file with no frontmatter", async () => {
  await assert.rejects(
    () => loadSkillBrief(path.join(__dirname, "fixtures/no-frontmatter.md")),
    /frontmatter/i,
  );
});
