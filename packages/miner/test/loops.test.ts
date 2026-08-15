import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoopProposals } from "../src/loops.js";
import type { CorrectionHit, LoopCluster, SessionCard } from "../src/types.js";

function makeCard(sessionId: string, openingPrompt: string): SessionCard {
  return {
    sessionId,
    project: "/fake/proj",
    openingPrompt,
    toolCounts: {},
    bashVerbs: {},
    subagentTypes: [],
    skillsInvoked: [],
    filesWritten: [],
    hasPrLink: false,
    prUrls: [],
    hasPlanArtifact: false,
    turnCount: 1,
  };
}

function makeHit(category: CorrectionHit["category"], sessionId: string, quote: string, lineIndex: number): CorrectionHit {
  return { sessionId, project: "/fake/proj", timestampMs: 0, quote, category, lineIndex };
}

test("loops: workflow proposals for clusters, preference proposals only for >=5-hit categories", () => {
  const cards: SessionCard[] = [
    makeCard("g1", "triage ticket ABC-111, please investigate this longer than one hundred and forty character prompt to test truncation behavior properly here yes"),
    makeCard("g2", "debug ticket ABC-222 error"),
    makeCard("u3", "fix ticket ABC-333, this is broken"),
  ];
  const clusters: LoopCluster[] = [
    {
      id: "ticket-error-triage",
      label: "ticket/error triage",
      sessionIds: ["g1", "g2", "u3"],
      gatedSessionIds: ["g1", "g2"],
      template: { label: "ticket/error triage", verbs: ["triage"], hasTicketOrPrSlot: true },
    },
  ];

  const revertQuotes = Array.from({ length: 6 }, (_, i) => `revert this change number ${i}`);
  const corrections: CorrectionHit[] = [
    ...revertQuotes.map((q, i) => makeHit("revert", `s${i}`, q, i)),
    makeHit("no-wrong", "s100", "no, that's wrong", 100),
    makeHit("no-wrong", "s101", "not correct at all", 101),
  ];

  const proposals = buildLoopProposals(clusters, corrections, cards);

  assert.equal(proposals.length, 2, "expected 1 workflow proposal + 1 preference proposal (revert has 6 hits, no-wrong has only 2)");

  const workflow = proposals.find((p) => p.kind === "workflow");
  assert.ok(workflow);
  assert.equal(workflow!.name, "Recurring workflow: ticket/error triage");
  assert.equal(workflow!.sessionCount, 3);
  assert.equal(workflow!.gatedSessionCount, 2);
  assert.equal(workflow!.status, "proposed");
  assert.equal(workflow!.exampleQuotes.length, 3);
  assert.ok(workflow!.exampleQuotes[0].length <= 141, "truncated to 140 chars + ellipsis");
  assert.ok(workflow!.exampleQuotes[0].endsWith("…"));

  const preference = proposals.find((p) => p.kind === "preference");
  assert.ok(preference);
  assert.equal(preference!.name, 'Preference: reduce "revert" corrections');
  assert.equal(preference!.sessionCount, 6);
  assert.equal(preference!.gatedSessionCount, 0);
  assert.equal(preference!.status, "proposed");
  assert.deepEqual(preference!.exampleQuotes, revertQuotes.slice(0, 3));
});

test("loops: no proposals when there are no clusters and no category clears the threshold", () => {
  const corrections: CorrectionHit[] = [
    makeHit("revert", "s1", "revert please", 0),
    makeHit("revert", "s2", "revert again", 1),
  ];
  const proposals = buildLoopProposals([], corrections, []);
  assert.deepEqual(proposals, []);
});
