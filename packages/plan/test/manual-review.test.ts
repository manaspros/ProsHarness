import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRunOptions, ModelRunResult, ModelSession } from "../src/model-session.js";
import { refinePlanWithInstruction, type PlanDoc } from "../src/plan.js";
import { runManualAdversarialReview } from "../src/manual-review.js";
import type { Finding } from "../src/finding.js";

const FINDING: Finding = {
  findingId: "finding-1",
  title: "off-by-one in loop bound",
  evidence: [{ file: "src/loop.ts", line: 12, snippet: "i <= arr.length" }],
  summary: "the loop reads one item past the end",
};

const PLAN: PlanDoc = {
  planId: "plan-1",
  version: 1,
  sessionId: "claude-session-1",
  markdown: "# Plan\n\nChange the loop bound.",
  structured: { steps: ["change the loop bound"], filesTouched: ["src/loop.ts"], risk: "low" },
};

class OrderedFakeSession implements ModelSession {
  readonly calls: ModelRunOptions[] = [];

  constructor(
    readonly provider: "claude" | "codex",
    private readonly responses: string[],
    private readonly order: string[],
    private readonly label: string,
    private readonly sessionIds: (string | undefined)[] = [],
  ) {}

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    this.calls.push(opts);
    this.order.push(this.label);
    const index = this.calls.length - 1;
    return {
      text: this.responses[Math.min(index, this.responses.length - 1)]!,
      sessionId: this.sessionIds[index],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const ASSESSMENT = JSON.stringify({ approach: "fix the bound", risks: ["boundary regression"] });
const OBJECTIONS = JSON.stringify({
  objections: [{ severity: "major", claim: "no regression test", suggested_change: "add a boundary test" }],
});
const REVISED = JSON.stringify({
  markdown: "# Revised plan\n\nChange the loop bound and add a regression test.",
  structured: {
    steps: ["change the loop bound", "add a regression test"],
    filesTouched: ["src/loop.ts", "test/loop.test.ts"],
    risk: "low",
    objectionResolutions: [{ claim: "no regression test", resolution: "accepted", note: "added the test" }],
  },
});

test("manual adversarial review calls Codex assessment, Codex critique, then resumes Claude", async () => {
  const order: string[] = [];
  const claude = new OrderedFakeSession("claude", [REVISED], order, "claude", ["claude-session-2"]);
  const codex = new OrderedFakeSession("codex", [ASSESSMENT, OBJECTIONS], order, "codex");

  const result = await runManualAdversarialReview({
    claudeSession: claude,
    codexSession: codex,
    cwd: "/repo",
    finding: FINDING,
    currentPlan: PLAN,
    attemptIdPrefix: "manual",
  });

  assert.deepEqual(order, ["codex", "codex", "claude"]);
  assert.equal(claude.calls[0]!.resumeSessionId, "claude-session-1");
  assert.equal(result.revisedPlan.sessionId, "claude-session-2");
  assert.equal(result.objections.length, 1);
});

test("user refinement forwards the requested Claude resume session id", async () => {
  const order: string[] = [];
  const claude = new OrderedFakeSession("claude", [REVISED], order, "claude", ["claude-session-3"]);

  const result = await refinePlanWithInstruction(claude, {
    cwd: "/repo",
    finding: FINDING,
    previous: PLAN,
    instruction: "Add a regression test and explain the boundary behavior.",
    resumeSessionId: "explicit-session-2",
    attemptId: "refine",
  });

  assert.equal(claude.calls[0]!.resumeSessionId, "explicit-session-2");
  assert.equal(result.version, 2);
  assert.equal(result.sessionId, "claude-session-3");
});
