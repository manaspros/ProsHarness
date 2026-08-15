import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenCeiling, TokenCeilingExceededError } from "@pros/lease";
import { buildDescription, withTokenCeiling } from "../src/admit.js";
import type { ModelRunOptions, ModelRunResult, ModelSession, ModelUsage } from "@pros/plan";
import type { Signal } from "../src/types.js";

/**
 * Only the pure helpers in admit.ts are exercised here: description-building
 * and the token-ceiling-wrapping ModelSession decorator. `createRealOnNewSignal`
 * itself (which wires runPlanPipeline) is deliberately NOT invoked by any test
 * in this package -- that would require a real git repo, worktree allocation,
 * and (absent injection) real CLI subprocesses. runner.test.ts already proves
 * the admission flow (dedup + lease + isolation) end-to-end using an injected
 * fake onNewSignal, which is the intended seam per the M7 brief.
 */

class FakeModelSession implements ModelSession {
  readonly provider = "claude" as const;
  calls = 0;
  constructor(private readonly usages: ModelUsage[]) {}
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    const usage = this.usages[Math.min(this.calls, this.usages.length - 1)];
    this.calls++;
    return { text: "{}", usage };
  }
}

test("buildDescription includes title, body, evidence file:line, and url", () => {
  const signal: Signal = {
    sourceId: "sweep",
    externalId: "abc",
    kind: "todo",
    title: "TODO in src/foo.ts",
    body: "// TODO: handle null",
    raisedAt: new Date().toISOString(),
    evidence: { file: "src/foo.ts", line: 42 },
  };
  const desc = buildDescription(signal);
  assert.match(desc, /TODO in src\/foo\.ts/);
  assert.match(desc, /handle null/);
  assert.match(desc, /Evidence: src\/foo\.ts:42/);
});

test("buildDescription includes url when present, with a read-only annotation", () => {
  const signal: Signal = {
    sourceId: "linear",
    externalId: "lin_1",
    kind: "issue",
    title: "Some issue",
    body: "body",
    url: "https://linear.app/example/issue/ENG-1",
    raisedAt: new Date().toISOString(),
  };
  const desc = buildDescription(signal);
  assert.match(desc, /https:\/\/linear\.app\/example\/issue\/ENG-1/);
  assert.match(desc, /read-only/);
});

test("buildDescription omits evidence/url sections when absent", () => {
  const signal: Signal = {
    sourceId: "slack",
    externalId: "s1",
    kind: "message",
    title: "a message",
    body: "some text",
    raisedAt: new Date().toISOString(),
  };
  const desc = buildDescription(signal);
  assert.doesNotMatch(desc, /Evidence:/);
  assert.doesNotMatch(desc, /Source reference/);
});

test("withTokenCeiling records usage after each run() and lets the throw propagate once exceeded", async () => {
  const ceiling = new TokenCeiling({ maxTotalTokens: 100 });
  const fake = new FakeModelSession([
    { inputTokens: 40, outputTokens: 10 }, // total 50, ok
    { inputTokens: 40, outputTokens: 20 }, // total 110, exceeds 100
  ]);
  const wrapped = withTokenCeiling(fake, ceiling);

  const first = await wrapped.run({ cwd: "/tmp", prompt: "p", attemptId: "a1" });
  assert.equal(first.text, "{}");
  assert.equal(ceiling.used(), 50);

  await assert.rejects(
    () => wrapped.run({ cwd: "/tmp", prompt: "p", attemptId: "a2" }),
    (err: unknown) => err instanceof TokenCeilingExceededError,
  );
  assert.equal(ceiling.used(), 110);
  assert.equal(fake.calls, 2, "both run() calls happened -- the ceiling throw is on record(), not on run() itself");
});

test("withTokenCeiling preserves the wrapped session's provider", () => {
  const fake = new FakeModelSession([{ inputTokens: 1, outputTokens: 1 }]);
  const wrapped = withTokenCeiling(fake, new TokenCeiling({ maxTotalTokens: 1000 }));
  assert.equal(wrapped.provider, "claude");
});
