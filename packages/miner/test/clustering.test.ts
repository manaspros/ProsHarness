import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterSessions } from "../src/clustering.js";
import type { SessionCard } from "../src/types.js";

function makeCard(overrides: Partial<SessionCard>): SessionCard {
  return {
    sessionId: "s",
    project: "/fake/proj",
    openingPrompt: "",
    toolCounts: {},
    bashVerbs: {},
    subagentTypes: [],
    skillsInvoked: [],
    filesWritten: [],
    hasPrLink: false,
    prUrls: [],
    hasPlanArtifact: false,
    turnCount: 1,
    ...overrides,
  };
}

test("clustering: ungated sessions never form a cluster no matter how many match", () => {
  const cards: SessionCard[] = [
    makeCard({ sessionId: "u1", openingPrompt: "triage ticket ABC-111, please investigate", hasPrLink: false, hasPlanArtifact: false }),
    makeCard({ sessionId: "u2", openingPrompt: "debug ticket ABC-222 error", hasPrLink: false, hasPlanArtifact: false }),
    makeCard({ sessionId: "u3", openingPrompt: "fix ticket ABC-333, this is broken", hasPrLink: false, hasPlanArtifact: false }),
    makeCard({ sessionId: "u4", openingPrompt: "investigate incident ABC-444", hasPrLink: false, hasPlanArtifact: false }),
  ];
  const clusters = clusterSessions(cards);
  assert.deepEqual(clusters, [], "no gated sessions -> no cluster, regardless of match count");
});

test("clustering: exactly 1 gated session among >=3 matches is still insufficient", () => {
  const cards: SessionCard[] = [
    makeCard({ sessionId: "g1", openingPrompt: "triage ticket ABC-111, please investigate", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "u2", openingPrompt: "debug ticket ABC-222 error", hasPrLink: false, hasPlanArtifact: false }),
    makeCard({ sessionId: "u3", openingPrompt: "fix ticket ABC-333, this is broken", hasPrLink: false, hasPlanArtifact: false }),
  ];
  const clusters = clusterSessions(cards);
  assert.deepEqual(clusters, [], "gating threshold is >=2, exactly 1 gated must still yield no cluster");
});

test("clustering: >=3 matches with >=2 gated produces a cluster with correct session sets", () => {
  const cards: SessionCard[] = [
    makeCard({ sessionId: "g1", openingPrompt: "triage ticket ABC-111, please investigate", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "g2", openingPrompt: "debug ticket ABC-222 error", hasPrLink: false, hasPlanArtifact: true }),
    makeCard({ sessionId: "u3", openingPrompt: "fix ticket ABC-333, this is broken", hasPrLink: false, hasPlanArtifact: false }),
  ];
  const clusters = clusterSessions(cards);
  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  assert.equal(cluster.label, "ticket/error triage");
  assert.deepEqual(new Set(cluster.sessionIds), new Set(["g1", "g2", "u3"]));
  assert.deepEqual(new Set(cluster.gatedSessionIds), new Set(["g1", "g2"]));
});

test("clustering: deterministic across repeated calls", () => {
  const cards: SessionCard[] = [
    makeCard({ sessionId: "g1", openingPrompt: "triage ticket ABC-111, please investigate", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "g2", openingPrompt: "debug ticket ABC-222 error", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "u3", openingPrompt: "fix ticket ABC-333, this is broken", hasPrLink: false, hasPlanArtifact: false }),
    makeCard({ sessionId: "r1", openingPrompt: "please review this pr #99, red team it", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "r2", openingPrompt: "review the pull request", hasPrLink: true, hasPlanArtifact: false }),
    makeCard({ sessionId: "r3", openingPrompt: "regression review on the pr", hasPrLink: false, hasPlanArtifact: false }),
  ];
  const first = clusterSessions(cards);
  const second = clusterSessions(cards);
  assert.deepEqual(second, first);
});
