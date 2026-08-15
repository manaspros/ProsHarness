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
| Adapters (`packages/adapters`) | **done** | `spawnClaude`/`spawnCodex`, tolerant NDJSON parsing, real fixtures captured live (both CLIs), snapshot tests. Commit `14444cc`. |
| SQLite index (`packages/index`) | **done** | `rebuildIndex(dbPath, runsRoot)` over `@pros/barrier`'s `Journal.read` + `attempts/*/raw.log`; dedup via `UNIQUE(run_id,attempt_id,seq)` + `INSERT OR IGNORE`; full rebuild-from-scratch verified idempotent. Commit `67457e4`. |
| Worktree allocator (`packages/worktree`) | **done** | Intent→act→confirm saga on top of `@pros/barrier`'s `Journal`; `reconcile()` finishes or rolls back every crash point tested. Commit `c365b6e`, fence-epoch fix in `3f7b313`. |
| Fence epoch extension | **done** (folded into worktree + barrier) | Worktree saga now carries the run's real current epoch (was hardcoded 0 — fixed). Plan pipeline (below) also fence-checks its own transitions. |
| Plan pipeline (`packages/plan`, `pros plan`) | pending | |
| Model routing | pending | documented as part of the plan pipeline's adapter invocation choices |

## Adapters package details

- `packages/adapters/src/{types,claude,codex,spawn-common,index}.ts`.
- Real fixtures captured live against `claude` 2.1.232 / `codex-cli` 0.147.0
  (subscription auth verified empty of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
  before and after): `test/fixtures/claude/claude-{pong,tool-call}.ndjson`,
  `test/fixtures/codex/codex-{pong,tool-call}.ndjson`.
- Real Codex tool-call fixture organically contains an `item.started` event
  type outside the hardcoded known-type allowlist — used directly to prove
  the tolerant-parsing invariant against real (not just synthetic) data.
- Codex resume argument order confirmed: global flags before `resume`,
  prompt as a trailing `-` positional to read from stdin.
- CLI version pinning is via a separate `--version` execFile call, not
  scraped from the event stream (neither CLI's init-style event carries a
  stable version field).

## SQLite index package details

- `packages/index/src/{schema,rebuild,index}.ts`.
- `rebuildIndex` is **async** (Journal.read is async — see file header
  comment for why this is not a spec violation).
- Full delete-and-recreate of the db file on every rebuild — a clean index,
  not a merge with stale rows.
- Known limitation, documented in code: raw.log has no reliable per-line
  timestamp (falls back to file mtime) and no reliable provider/cli_version
  without an optional sidecar file — real gaps, not silently papered over.
- `pnpm-workspace.yaml`'s `allowBuilds.better-sqlite3` flipped to `true` so
  pnpm allows the native build script to run (required for the dependency to
  install at all).

## Worktree allocator package details

- `packages/worktree/src/allocator.ts`.
- Saga entries live in the SAME per-run `journal.ndjson` as the checkpoint
  barrier's own entries (`worktree_intent`/`_allocated`/`_confirmed`/`_rollback`),
  reusing `@pros/barrier`'s `Journal`/`loadRunState` rather than inventing a
  second durability mechanism.
- Design choice for "git worktree add succeeded but the journal entry
  recording it never landed": **reconcile adopts it** (treats a real,
  git-verified worktree as legitimate work and finishes the saga) rather than
  destroying it. Only a provably inconsistent/partial artifact (directory
  exists but git doesn't know about it, or vice versa) is rolled back.
- `crashAfter: "intent"|"act"|"allocated"` is a test-only injection hook on
  `allocate()`, mirroring M1's `Journal.simulateIOFailureOnce()` pattern.

## How to run the tests so far

```
pnpm -r typecheck
pnpm -r test              # runs M1 (barrier, mcp, cli) + M2 (adapters, index, worktree) together
pnpm --filter @pros/adapters test
pnpm --filter @pros/index test
pnpm --filter @pros/worktree test
```

All green as of commit `3f7b313`, including M1's 20 barrier kill-tests and
the (occasionally-skipping-by-design, never-flaky) real-CLI mcp acceptance
test.

## Known gaps (so far)

- Plan pipeline not yet built (see status table) — this is where the
  debate-round cap, per-run token ceiling, and the stubbed
  "critique changed the plan" test will land.
- `packages/index`'s raw.log timestamp/provider inference is best-effort
  (see above) — a real limitation of deriving from bare text logs with no
  sidecar metadata, not a bug.
- No `pros reconcile` CLI command yet wired up to `packages/worktree`'s
  `reconcile()` — the function exists and is tested directly; a thin CLI
  wrapper is small remaining work if time allows (not a stated M2
  acceptance criterion, `pros reconcile` is named in the architecture doc's
  worktree section but M2's own acceptance list doesn't require a CLI verb
  for it, only the allocator + reconcile logic itself).
