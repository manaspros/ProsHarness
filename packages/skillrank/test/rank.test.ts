import { test } from "node:test";
import assert from "node:assert/strict";
import { rankProposals } from "../src/rank.js";
import { SKILL_CATALOG } from "../src/catalog.js";
import type { LocalSignals } from "../src/signals.js";

test("rankProposals ranks matching candidates above non-matching, excludes installed, and sets status invariant", () => {
  const signals: LocalSignals = {
    bashVerbs: ["git", "worktree"],
    toolNames: ["Bash"],
    fileExtensions: [".ts"],
    installedSlugs: ["obra/brainstorming"],
  };

  const proposals = rankProposals(SKILL_CATALOG, signals);

  // (b) obra/brainstorming never appears, even though "brainstorm"/"design"
  // keywords could otherwise be considered -- it's excluded purely by
  // being in installedSlugs, not by lack of match.
  assert.ok(!proposals.some((p) => p.slug === "obra/brainstorming"));

  // (a) matching candidates (worktree-related) rank above non-matching ones.
  const worktreeProposal = proposals.find((p) => p.slug === "obra/using-git-worktrees");
  assert.ok(worktreeProposal, "expected obra/using-git-worktrees to be proposed");
  const parallelProposal = proposals.find((p) => p.slug === "rohitg00/parallel-worktrees");
  assert.ok(parallelProposal, "expected rohitg00/parallel-worktrees to be proposed");

  // Every score-0 candidate (e.g. deployment/database/api ones, no matching
  // keywords here) must be absent entirely.
  assert.ok(!proposals.some((p) => p.slug === "example/deployment-runbook"));
  assert.ok(!proposals.some((p) => p.slug === "example/database-migration-helper"));

  // Descending score order.
  for (let i = 1; i < proposals.length; i++) {
    assert.ok(proposals[i - 1].score >= proposals[i].score);
  }

  // (c) every proposal literally has status === "proposed".
  for (const p of proposals) {
    assert.equal(p.status, "proposed");
  }

  // Reason string is grounded in real matched keywords.
  for (const p of proposals) {
    for (const kw of p.matchedKeywords) {
      assert.ok(p.reason.includes(kw), `reason should mention matched keyword ${kw}`);
    }
  }
});

test("rankProposals excludes zero-score candidates entirely", () => {
  const signals: LocalSignals = {
    bashVerbs: [],
    toolNames: [],
    fileExtensions: [],
    installedSlugs: [],
  };
  const proposals = rankProposals(SKILL_CATALOG, signals);
  assert.deepEqual(proposals, []);
});

test("rankProposals sorts ties alphabetically by slug", () => {
  const signals: LocalSignals = {
    bashVerbs: ["git"],
    toolNames: [],
    fileExtensions: [],
    installedSlugs: [],
  };
  const proposals = rankProposals(SKILL_CATALOG, signals);
  // Both git-related candidates should score 1 here; confirm stable
  // alphabetical tiebreak among any equal-score group.
  for (let i = 1; i < proposals.length; i++) {
    if (proposals[i - 1].score === proposals[i].score) {
      assert.ok(proposals[i - 1].slug.localeCompare(proposals[i].slug) <= 0);
    }
  }
});
