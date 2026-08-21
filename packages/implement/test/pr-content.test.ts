import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRunOptions, ModelRunResult } from "@pros/plan";
import { runVerification, noCommitVerdict, type Verdict } from "../src/verify.js";
import type { CodexAdvisoryResult } from "../src/review.js";
import {
  buildPrContent,
  derivePrTitle,
  derivePrTitleSource,
  fenceMermaid,
  renderCodexAdvisorySection,
  stripTicketIds,
  toSafeInline,
  PrTitleValidationError,
} from "../src/pipeline.js";

class SummarySession {
  readonly provider = "claude" as const;
  async run(_opts: ModelRunOptions): Promise<ModelRunResult> {
    return { text: JSON.stringify({ summary: "ok" }), usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** Builds a real, harness-derived Verdict (Verdict is unconstructible outside verify.ts's brand) by actually running validation commands. */
async function makeVerdict(commands: { command: string; label?: string }[]): Promise<Verdict> {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-pr-content-test-"));
  const runDir = path.join(runsRoot, "run-1");
  await mkdir(runDir, { recursive: true });
  try {
    return await runVerification({
      verifierSession: new SummarySession(),
      worktreePath: process.cwd(),
      runId: "run-1",
      runDir,
      expectedFenceEpoch: 0,
      attemptId: "run-1-verify",
      validationCommands: commands,
    });
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const PASS_VERDICT = () => makeVerdict([{ command: "exit 0", label: "check-a" }]);

test("stripTicketIds removes bracketed and bare ticket references", () => {
  assert.equal(stripTicketIds("[AGENT-1234] fix the thing"), "fix the thing");
  assert.equal(stripTicketIds("fix the thing (ENGOPS-456)"), "fix the thing");
  assert.equal(stripTicketIds("ZD-1234: fix the thing"), ": fix the thing".trim());
});

test("derivePrTitle produces verb: object and rejects a ticket ID from reaching the title", () => {
  const title = derivePrTitle("AGENT-1234 Add input validation to the webhook handler");
  assert.match(title, /^[a-z-]+: .+/);
  assert.ok(!/[A-Z]{2,}-\d+/.test(title), `title must not contain a ticket id: ${title}`);
});

test("derivePrTitle keeps an already verb:object claim as-is (after ticket stripping)", () => {
  const title = derivePrTitle("fix: memory leak in worker pool (AGENT-99)");
  assert.equal(title, "fix: memory leak in worker pool");
});

test("derivePrTitle throws PrTitleValidationError rather than opening a badly-titled PR when nothing satisfies the pattern", () => {
  assert.throws(() => derivePrTitle("AGENT-1234", /^[a-z]+: .+/), PrTitleValidationError);
});

test("derivePrTitleSource prefers planClaim over planMarkdown, and falls back cleanly when planClaim is absent", () => {
  assert.equal(
    derivePrTitleSource({ planClaim: "Add caching to the lookup path", planMarkdown: "# unrelated heading\nbody" }),
    "Add caching to the lookup path",
  );
  assert.equal(
    derivePrTitleSource({ planMarkdown: "# Add caching to the lookup path\n\nrest of plan" }),
    "Add caching to the lookup path",
  );
});

test("fenceMermaid omits the block cleanly for missing/blank input, never emitting an empty or broken fence", () => {
  assert.equal(fenceMermaid(undefined), undefined);
  assert.equal(fenceMermaid(""), undefined);
  assert.equal(fenceMermaid("   \n  "), undefined);
});

test("fenceMermaid widens the fence so an embedded ``` inside the diagram cannot break out of the block", () => {
  const malicious = "graph TD\nA-->B\n```\n## Fake heading injected via diagram\n```";
  const block = fenceMermaid(malicious)!;
  const lines = block.split("\n");
  const openFence = lines[0]!;
  const closeFence = lines[lines.length - 1]!;
  assert.match(openFence, /^`{4,}mermaid$/);
  assert.equal(openFence.replace("mermaid", ""), closeFence);
  // The embedded ``` must appear only inside the block, never as a shorter
  // fence capable of prematurely closing our wider one.
  const innerBacktickRuns = block.slice(openFence.length, block.length - closeFence.length).match(/`+/g) ?? [];
  for (const run of innerBacktickRuns) {
    assert.ok(run.length < openFence.length - "mermaid".length, `embedded backtick run ${run} must be shorter than the fence`);
  }
});

test("toSafeInline flattens newlines so embedded markdown cannot start a fake heading or list item", () => {
  const hostile = "looks fine\n## Injected heading\n- injected bullet";
  const safe = toSafeInline(hostile);
  assert.ok(!safe.includes("\n"), "must be a single line");
  assert.match(safe, /^looks fine ## Injected heading - injected bullet$/);
});

test("renderCodexAdvisorySection: unavailable never renders as reviewed-clean", () => {
  const unavailable: CodexAdvisoryResult = { status: "unavailable", findings: [], unavailableReason: "codex exec timed out" };
  const text = renderCodexAdvisorySection(unavailable);
  assert.match(text, /Unavailable/);
  assert.doesNotMatch(text.toLowerCase(), /no blocker/);
});

test("renderCodexAdvisorySection: disabled/undefined project pass is distinct from both reviewed states", () => {
  const text = renderCodexAdvisorySection(undefined);
  assert.match(text, /Not run for this project/);
});

test("renderCodexAdvisorySection: reviewed_no_blocker renders as clean, reviewed_blocker surfaces findings without gating", () => {
  const clean: CodexAdvisoryResult = { status: "reviewed_no_blocker", findings: [] };
  assert.match(renderCodexAdvisorySection(clean), /no blocker/i);

  const blocker: CodexAdvisoryResult = {
    status: "reviewed_blocker",
    findings: [{ severity: "blocker", claim: "possible data race" }],
  };
  const text = renderCodexAdvisorySection(blocker);
  assert.match(text, /possible data race/);
  assert.match(text, /advisory only/i);
});

test("buildPrContent: full body includes verification, codex section, and a mandatory AGENTS.md delta line; reproduction renders not-established", async () => {
  const verdict = await PASS_VERDICT();
  const { title, body } = buildPrContent({
    runId: "run-42",
    planClaim: "Add retry to the flaky webhook call",
    planMarkdown: "# irrelevant",
    planDiagram: "graph TD\nA-->B",
    verdict,
    codexAdvisory: { status: "reviewed_no_blocker", findings: [] },
    unresolvedNonBlockers: [],
    prTitlePattern: /^[a-z]+: .+/,
  });

  assert.match(title, /^add: /);
  assert.ok(!/[A-Z]{2,}-\d+/.test(title));
  assert.match(body, /## Summary/);
  assert.match(body, /## Diagram/);
  assert.match(body, /```mermaid/);
  assert.match(body, /## Verification/);
  assert.match(body, /not established/);
  assert.match(body, /## Codex advisory review/);
  assert.match(body, /## AGENTS\.md delta\?/);
  assert.match(body, /Run: `run-42`/);
});

test("buildPrContent: diagram section is omitted cleanly when planDiagram is absent", async () => {
  const verdict = await PASS_VERDICT();
  const { body } = buildPrContent({
    runId: "run-1",
    planMarkdown: "# fix the flaky retry path",
    verdict,
    codexAdvisory: undefined,
    unresolvedNonBlockers: [],
  });
  assert.doesNotMatch(body, /## Diagram/);
  assert.doesNotMatch(body, /```mermaid/);
});

test("buildPrContent: no ticket ID reaches the title or the body, even from objections/claims", async () => {
  const verdict = await PASS_VERDICT();
  const { title, body } = buildPrContent({
    runId: "run-1",
    planClaim: "AGENT-777 Fix the retry loop",
    planMarkdown: "# unused",
    verdict,
    codexAdvisory: undefined,
    unresolvedNonBlockers: [
      { severity: "major", claim: "AGENT-888 missing test coverage", suggested_change: "add a regression test (ENGOPS-1)", resolution: "rejected" } as any,
    ],
  });
  const full = `${title}\n${body}`;
  assert.ok(!/[A-Z]{2,}-\d+/.test(full), `no ticket id anywhere in title/body: ${full}`);
});

test("buildPrContent: a ``` inside an objection's text cannot break the body structure", async () => {
  const verdict = await PASS_VERDICT();
  const { body } = buildPrContent({
    runId: "run-1",
    planMarkdown: "# fix something",
    verdict,
    codexAdvisory: undefined,
    unresolvedNonBlockers: [
      {
        severity: "minor",
        claim: "line1\n```\n## Injected heading\n```\nline2",
        suggested_change: "n/a",
        resolution: "rejected",
      } as any,
    ],
  });
  // toSafeInline flattens newlines, so the objection's own embedded fence
  // can never land at the start of a line and open a real code block.
  assert.doesNotMatch(body, /\n```\n/);
  assert.match(body, /Injected heading/); // content survives, just neutralized
});

test("buildPrContent: reproduced-before-fix is reported as not established, never as pass or silently absent", async () => {
  const verdict = await PASS_VERDICT();
  const { body } = buildPrContent({
    runId: "run-1",
    planMarkdown: "# Plan\nFix the retry loop.",
    verdict,
    codexAdvisory: undefined,
    unresolvedNonBlockers: [],
  });
  assert.match(body, /Reproduced before the fix.*not established/s);
});

test("buildPrContent: a failing verdict still renders a full, honest body (never a pass)", async () => {
  const failVerdict = noCommitVerdict("implementation produced no commit");
  const { body } = buildPrContent({
    runId: "run-1",
    planMarkdown: "# Plan\nFix the retry loop.",
    verdict: failVerdict,
    codexAdvisory: undefined,
    unresolvedNonBlockers: [],
  });
  assert.match(body, /FAIL/);
});
