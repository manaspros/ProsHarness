---
name: review
description: "Adversarial review of a diff/PR before it is offered to a human at Gate 2: runs an independent Codex adversarial pass plus a fresh top-tier `claude ultrareview` self-review pass, collects both as severity-tagged objections (same shape as Gate 1's plan critique), and gates draft-PR creation on blockers being resolved or explicitly waived."
---

# Gate 2 review

## Why this is a skill, not an agent

This is a deliberate architectural choice recorded in this project's
decision log (D20), not an oversight. Review is nearly always immediately
followed by "now fix it" -- keeping the procedure in the current context (a
set of instructions this session follows) is cheaper than a subagent
round-trip, and there is no isolation or permission benefit to spawning a
separate context for a read-mostly critique pass over a diff that's already
sitting in front of you.

Contrast this with implementation: implementation genuinely needs its own
worktree-scoped context and Sonnet-tier cost routing, so it is isolated as
an agent (`implementer` / `scoped-fixer`). Review needs neither -- there is
no worktree to isolate it from and no cheaper model tier to route it to
(the adversarial passes below still want strong reasoning). So review stays
a skill: instructions the current session follows, not a place that needs
its own context window.

## The procedure

Follow these steps, in order, over the diff/PR being reviewed before it
reaches a human at Gate 2:

### 1. Codex adversarial review

Invoke Codex (the `codex exec` CLI, driven the same way this project drives
it elsewhere -- see `packages/plan/src/critique.ts` and
`packages/plan/src/real-sessions.ts`'s `RealClaudeSession`/Codex equivalent
for the calling convention) against the diff, as an independent adversary,
never as a rubber stamp. Ask it to find real, concrete problems:

- correctness bugs
- missed edge cases
- whether the diff actually satisfies the approved plan (Gate 1), not just
  whether it compiles or "looks done"
- security issues

Instruct Codex explicitly to find objections, not to compliment the diff --
this mirrors the adversarial plan-critique pattern already used at Gate 1.

### 2. `claude ultrareview`

Run a second, independent top-tier-model self-review pass over the **same**
diff -- a fresh context, not the implementer's session that wrote the code,
and not Codex's session from step 1. Its job is specifically to hunt for
what an adversarial reviewer would flag that the implementer -- reasoning
about its own work -- would be structurally prone to miss:

- silent scope creep beyond the approved plan
- an untested edge case
- a change that "looks done" but leaves the repo in a broken state (e.g.
  uncommitted files, a failing test the diff doesn't fix, a partial
  refactor)

### 3. Collect objections in the shared shape

Collect both passes' findings as **objections**, each tagged with a
severity (`blocker` / `major` / `minor`), using the exact same shape already
used for Gate 1 plan critique -- see `packages/plan/src/critique.ts`'s
`Objection` interface:

```ts
export interface Objection {
  severity: Severity; // "blocker" | "major" | "minor"
  claim: string;
  suggested_change: string;
  resolution?: "accepted" | "rejected" | "unresolved";
}
```

Using the same shape here is deliberate, not incidental: it keeps Gate 1
and Gate 2 bookkeeping consistent instead of inventing a second vocabulary
for the same kind of decision.

### 4. Resolve or waive every blocker before a draft PR opens

A draft PR is only opened once every `blocker` objection is either:

- **resolved** (the diff was fixed and, ideally, re-checked), or
- **explicitly accepted/waived** with a stated reason -- exactly the same
  accepted-vs-unresolved bookkeeping already used for Gate 1's plan debate.

Unresolved blockers must never be silently dropped. Even if the automated
pipeline decides to proceed past a `major`/`minor` objection, unresolved
blockers ship as visible context on the draft PR (e.g. in its description)
so the human at Gate 2 sees them.

### 5. This procedure and the automated pipeline stay in sync on purpose

This skill's output feeds `pros`'s Gate 2 pipeline (`@pros/implement`, built
in parallel with this file). Its `review.ts` module is the automated,
non-interactive equivalent of this same procedure -- it literally loads
this file's text and folds it into the review-session prompt, so the
interactive-skill path and the automated-pipeline path stay in sync rather
than drifting into two different review procedures over time. If you change
this procedure, the automated pipeline picks it up automatically -- don't
hand-duplicate this logic in `review.ts` instead of updating this file.
