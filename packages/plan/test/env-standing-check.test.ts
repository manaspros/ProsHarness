import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Project-wide standing check (verified for the first time here in M2):
 * no API-billing credential env var is set for this single-user,
 * subscription-only system (docs/00-decisions.md D1/D21 -- there is no
 * pay-per-token API path to accidentally hit).
 *
 * DEVIATION from the plan's literal instruction (`env | grep -iE
 * 'ANTHROPIC|OPENAI'` must stay empty), documented consistently with
 * docs/05-m2-implementation-log.md's "Design decisions for M2" section:
 * that naive substring grep has a known false positive on this dev
 * machine -- `PATH` contains a Claude Code plugin install path with the
 * substring `openai-codex`, and `CLAUDE_PLUGIN_DATA` contains the
 * substring `openai`. Neither is an actual credential. This test asserts
 * the precise, intended thing instead: no env var *shaped like*
 * `ANTHROPIC_..._KEY` / `OPENAI_..._KEY` is set.
 */
test("standing check: no ANTHROPIC_*/OPENAI_*-shaped API-billing credential env var is set", () => {
  const offenders = Object.keys(process.env).filter(
    (k) => /^(ANTHROPIC|OPENAI)_[A-Z_]*$/.test(k) && k.includes("KEY"),
  );
  assert.deepEqual(offenders, [], `found credential-shaped env var(s): ${offenders.join(", ")}`);
});
