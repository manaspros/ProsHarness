import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { Journal } from "@pros/barrier";
import { runDebate, DEBATE_ROUND_CAP } from "../src/debate.js";
import type { Finding } from "../src/finding.js";
import { ScriptedSession, makeRunDir } from "./helpers.js";

const FINDING: Finding = {
  findingId: "finding-1",
  title: "off-by-one in loop bound",
  evidence: [{ file: "src/loop.ts", line: 12, snippet: "for (let i = 0; i <= arr.length; i++) {" }],
  summary: "the loop bound uses <= instead of <, causing an out-of-bounds read",
};

const draftV1 = JSON.stringify({
  markdown: "# Plan v1\n\nChange `<=` to `<` in the loop bound.",
  structured: { steps: ["fix the loop bound"], filesTouched: ["src/loop.ts"], risk: "low" },
});

const independentAssessmentText = JSON.stringify({
  approach: "read src/loop.ts and confirm the off-by-one, then fix the comparison operator",
  risks: ["make sure no other callers rely on the (buggy) inclusive bound"],
});

test("critique changed the plan: a blocker objection from a stubbed critique produces a materially different revised plan", async () => {
  const { runsRoot, runId, runDir } = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);

    const claude = new ScriptedSession("claude", [
      { text: draftV1 },
      {
        text: JSON.stringify({
          markdown: "# Plan v2\n\nChange `<=` to `<` in the loop bound, AND add a regression test at test/loop.test.ts.",
          structured: {
            steps: ["fix the loop bound", "add a regression test covering the boundary"],
            filesTouched: ["src/loop.ts", "test/loop.test.ts"],
            risk: "low",
            objectionResolutions: [
              {
                claim: "the plan does not add a regression test for the boundary condition",
                resolution: "accepted",
                note: "added test/loop.test.ts covering the boundary",
              },
            ],
          },
        }),
      },
    ]);

    const codex = new ScriptedSession("codex", [
      { text: independentAssessmentText },
      {
        text: JSON.stringify({
          objections: [
            {
              severity: "blocker",
              claim: "the plan does not add a regression test for the boundary condition",
              suggested_change: "add a regression test at test/loop.test.ts asserting the boundary index is excluded",
            },
          ],
        }),
      },
    ]);

    const debate = await runDebate({
      claudeSession: claude,
      codexSession: codex,
      cwd: runsRoot,
      finding: FINDING,
      journal,
      runId,
      runDir,
      attemptIdPrefix: "test",
    });

    // The revised plan must materially differ in the way the objection demanded.
    assert.ok(
      (debate.finalPlan.structured as any).filesTouched.includes("test/loop.test.ts"),
      "revised plan must incorporate the suggested regression test file",
    );
    assert.notEqual(debate.finalPlan.markdown, draftV1, "markdown must actually change");
    assert.equal(debate.finalPlan.version, 2);

    assert.equal(debate.allObjections.length, 1);
    assert.equal(debate.allObjections[0]!.resolution, "accepted");
    assert.equal(debate.unresolvedObjections.length, 0, "the accepted objection must not remain in unresolvedObjections");
    assert.equal(debate.cappedReason, undefined, "natural convergence must not set cappedReason");

    const { entries } = await Journal.read(runDir);
    const kinds = entries.map((e) => e.kind);
    const expectedSubsequence = [
      "plan_drafted",
      "critique_independent",
      "critique_objections",
      "plan_revised",
      "plan_finalized",
    ];
    // Assert the exact contiguous sequence appears (this run only ever appends these kinds).
    assert.deepEqual(
      kinds.filter((k) => expectedSubsequence.includes(k)),
      expectedSubsequence,
    );

    let lastEpoch = -1;
    for (const e of entries) {
      assert.ok(e.fenceEpoch >= lastEpoch, "fence epochs must be non-decreasing");
      lastEpoch = e.fenceEpoch;
    }
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("round cap: an ever-unresolved blocker stops the loop at exactly DEBATE_ROUND_CAP rounds", async () => {
  const { runsRoot, runId, runDir } = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);

    const claude = new ScriptedSession("claude", (_opts, idx) =>
      idx === 0
        ? { text: draftV1 }
        : {
            text: JSON.stringify({
              markdown: `# Plan v${idx + 1}\n\nStill working on it.`,
              structured: {
                steps: ["fix the loop bound"],
                filesTouched: ["src/loop.ts"],
                risk: "low",
                objectionResolutions: [], // never accepts anything -- objections stay unresolved
              },
            }),
          },
    );

    const codex = new ScriptedSession("codex", (_opts, idx) =>
      idx === 0
        ? { text: independentAssessmentText }
        : {
            text: JSON.stringify({
              objections: [
                {
                  severity: "blocker",
                  claim: `fresh objection #${idx}`,
                  suggested_change: `do something about #${idx}`,
                },
              ],
            }),
          },
    );

    const debate = await runDebate({
      claudeSession: claude,
      codexSession: codex,
      cwd: runsRoot,
      finding: FINDING,
      journal,
      runId,
      runDir,
      attemptIdPrefix: "test",
    });

    assert.equal(debate.roundsRun, DEBATE_ROUND_CAP);
    assert.ok(debate.cappedReason, "must set a cappedReason");
    assert.match(debate.cappedReason!, /round cap/i);
    assert.ok(debate.unresolvedObjections.length > 0, "unresolved objections must remain");

    const { entries } = await Journal.read(runDir);
    const kinds = entries.map((e) => e.kind);
    assert.ok(kinds.includes("debate_capped"));
    const capped = entries.find((e) => e.kind === "debate_capped") as any;
    assert.match(capped.reason, /round cap/i);
    const finalized = entries.find((e) => e.kind === "plan_finalized") as any;
    assert.ok(finalized, "plan_finalized must still be appended even when capped");
    assert.ok(JSON.parse(finalized.unresolvedObjectionsJson).length > 0);
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("token ceiling: a very low ceiling stops the debate before it is exceeded, citing the ceiling not the round cap", async () => {
  const { runsRoot, runId, runDir } = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);
    const bigUsage = { inputTokens: 100_000, outputTokens: 100_000 };

    const claude = new ScriptedSession("claude", [{ text: draftV1, usage: bigUsage }, { text: draftV1, usage: bigUsage }]);
    const codex = new ScriptedSession("codex", [
      { text: independentAssessmentText, usage: bigUsage },
      {
        text: JSON.stringify({
          objections: [{ severity: "blocker", claim: "x", suggested_change: "y" }],
        }),
        usage: bigUsage,
      },
    ]);

    const debate = await runDebate({
      claudeSession: claude,
      codexSession: codex,
      cwd: runsRoot,
      finding: FINDING,
      journal,
      runId,
      runDir,
      attemptIdPrefix: "test",
      tokenCeiling: 100, // far below what draft+assess+critique1 alone already report
    });

    assert.ok(debate.cappedReason, "must set a cappedReason");
    assert.match(debate.cappedReason!, /token ceiling/i);
    assert.doesNotMatch(debate.cappedReason!, /round cap/i);
    // revisePlan (claude's 2nd scripted call) must never have been reached.
    assert.equal(claude.callCount, 1, "revisePlan must not be called once the ceiling is already hit");

    const { entries } = await Journal.read(runDir);
    assert.ok(entries.some((e) => e.kind === "plan_finalized"), "plan_finalized must still be appended");
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("natural convergence: zero objections on round 1 stops the loop with no debate_capped entry", async () => {
  const { runsRoot, runId, runDir } = await makeRunDir();
  try {
    const journal = await Journal.open(runDir);

    const claude = new ScriptedSession("claude", [{ text: draftV1 }]);
    const codex = new ScriptedSession("codex", [
      { text: independentAssessmentText },
      { text: JSON.stringify({ objections: [] }) },
    ]);

    const debate = await runDebate({
      claudeSession: claude,
      codexSession: codex,
      cwd: runsRoot,
      finding: FINDING,
      journal,
      runId,
      runDir,
      attemptIdPrefix: "test",
    });

    assert.equal(debate.roundsRun, 1);
    assert.equal(debate.cappedReason, undefined);
    assert.equal(debate.unresolvedObjections.length, 0);

    const { entries } = await Journal.read(runDir);
    assert.ok(!entries.some((e) => e.kind === "debate_capped"));
    assert.ok(entries.some((e) => e.kind === "plan_finalized"));
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
