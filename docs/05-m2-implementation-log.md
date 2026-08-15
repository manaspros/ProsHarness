# M2 implementation log - `pros plan`

Status: **IN PROGRESS** (this file is updated incrementally; if the session was
cut off, this section reflects the true state, not aspiration).

Environment: `claude` 2.1.232, `codex-cli` 0.147.0, Node v24.18.1, pnpm 11.3.0,
same machine as M1.

## Scope (from the roadmap, docs/03-architecture.md M2 row)

`pros plan`: finding -> Claude plan -> independent Codex critique -> debate ->
plan + structured objections. Adapters, raw capture, worktree allocator, fence
epochs. No UI. Explicitly NOT in scope: dashboard, Gate 1 hooks, `submit_plan`,
push notifications, PR creation, session graph, learning loop (M3+).

## Package layout (planned)

```
packages/adapters/     spawnClaude/spawnCodex, tolerant line parsers, fixture capture + snapshot tests
packages/index/        SQLite rebuildable index over the journal + raw logs (raw_events, events, plans, objections)
packages/worktree/      allocator saga (intent -> act -> confirm), reconcile, crash-injection tests
packages/plan/          the plan pipeline: finding -> plan -> independent critique -> bounded debate
packages/cli/           + `pros plan <target>` command (extends M1's cli package)
packages/barrier/       extended: new JournalEntry kinds for worktree allocation + plan/critique/debate, reused as-is otherwise
```

## Design decisions for M2 (recorded as made, with reasoning)

- **Journal entry kinds extended, not duplicated.** Worktree allocation and
  plan/critique/debate all append to the *same* per-run `journal.ndjson` via
  the M1 `Journal`/`Fence` classes, using new `JournalEntry` union members
  (`worktree_intent`, `worktree_allocated`, `worktree_confirmed`,
  `worktree_rollback`, `finding_recorded`, `plan_drafted`, `critique_independent`,
  `critique_objections`, `plan_revised`, `debate_capped`, `plan_finalized`).
  This keeps "the journal is the sole authority, SQLite is a rebuildable
  index" true for M2's new state too, instead of inventing a second
  durability mechanism.
- **Debate round cap: 2** (matches D11/architecture's stated default).
  Documented as a named constant, not a magic number, in `packages/plan`.
- **Per-run token ceiling**: default enforced in `packages/plan`, tracked
  from each adapter's own usage-accounting event (Claude's `result.usage`,
  Codex's `turn.completed.usage`). See implementation section below for the
  chosen number and why.
- **Independence mechanism**: Codex's *first* opinion is generated from the
  finding + repo only, before it ever sees Claude's plan text, matching the
  architecture's "critical invariant, borrowed from the neuroarxiv skill's
  isolation rule."
- **Standing check deviation**: the plan's literal
  `env | grep -iE 'ANTHROPIC|OPENAI'` check has a false positive on this
  machine: `PATH` includes `.../openai-codex/codex/...` (a Claude Code plugin
  install path) and `CLAUDE_PLUGIN_DATA` contains the substring `openai`.
  Neither is `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. The test asserts the
  precise thing the check is meant to prove -- no API-billing credential env
  var is set -- via `grep -iE '^(ANTHROPIC|OPENAI)_[A-Z_]*='`, and documents
  why the naive form is not usable verbatim in this environment.

(Sections below filled in as each component lands.)

## Component status

| Component | Status | Notes |
|---|---|---|
| Adapters (`packages/adapters`) | pending | |
| SQLite index (`packages/index`) | pending | |
| Worktree allocator (`packages/worktree`) | pending | |
| Fence epoch extension | pending | |
| Plan pipeline (`packages/plan`, `pros plan`) | pending | |
| Model routing | pending | |

## How to run the tests

TBD once components land.

## Known gaps

TBD.
