# M5 implementation log -- session graph + review page

Status: **COMPLETE**. `@pros/graph`, `@pros/review` (+ the minimal
`@pros/implement` journaling addition), and the dashboard's new
`/runs/[runId]/graph` and `/runs/[runId]/review` pages are all done and
tested. `pnpm -r typecheck` is clean across all 15 packages (14 with a
typecheck script) and `pnpm -r test` is green (see final counts below).
Every M5 acceptance criterion has a real, passing test.

## M5 scope (from the roadmap / brief)

1. Session graph -- rendered deterministically from recorded events in the
   SQLite index. Zero LLM involvement. Every node traces back to a real
   `raw_events` row (row identity carried into the rendered node).
2. Review page in the M3 dashboard -- risk-ranked hunks + focus checklist,
   the Gate 2 human surface, teaching over jargon.
3. Code diagrams (if rendered): a diagram citing a symbol absent from the
   real AST must fail the build (a negative test proves this).
4. Risk ranking: deterministic where possible (diff size, blast radius, test
   coverage of touched files, verification flags). Any model use is
   advisory-only, clearly labelled, never a structural claim.

Explicitly NOT in scope: learning loop / correction mining / session cards /
Loops page (M6); ambient triggers (M7).

## Package layout (plan)

```
packages/graph/     @pros/graph -- buildSessionGraph(db, runId): reads raw_events
                     for a run from the @pros/index SQLite db, parses each row
                     via @pros/adapters' parseClaudeLine/parseCodexLine (parsing
                     only -- no spawning, no model calls), emits {nodes, edges}
                     where every node carries {rawEventId, runId, attemptId, seq}.
packages/review/     @pros/review -- risk-ranked hunks (git diff based, deterministic
                     scoring), focus checklist, AST symbol validator + a
                     build-time diagram-validation script that fails on a
                     citation to a symbol absent from the real TS AST.
packages/dashboard/  new pages: /runs/[runId]/graph (session graph),
                     /runs/[runId]/review (Gate 2 risk-ranked hunks + checklist).
packages/implement/  minimal addition: pipeline.ts now durably journals
                     verify_verdict / review_completed (same tolerant,
                     loosely-typed-append pattern already used for
                     pr_create_intent/pr_created) so the review page has a
                     real recorded verdict/review to read, not just an
                     in-memory pipeline return value.
```

## Design decisions

- **`@pros/graph` reuses `@pros/adapters`' pure parsers, never its spawn
  functions.** `buildSessionGraph(db, runId)` reads `raw_events` rows for a
  run (already populated by `@pros/index`'s `rebuildIndex` from
  `attempts/<attemptId>/raw.log`), and re-parses each row's `raw_text` via
  `parseClaudeLine`/`parseCodexLine` -- both pure `JSON.parse` + type-check
  functions with zero subprocess/network involvement. `spawnClaude`/
  `spawnCodex` are never imported anywhere in `packages/graph/src`. This is
  what makes "zero LLM involvement" true by construction, not just by
  testing.
- **Every graph node carries a real `rawEventId`** (the `raw_events.id`
  primary key of the row it was derived from) -- including `kind: "unknown"`
  nodes for malformed/unrecognized-type rows, which are surfaced, never
  dropped (continuing the M3 "unknown events must surface, never look
  healthy" invariant into the session graph).
- **`@pros/review` is a leaf package** -- no dependency on `@pros/adapters`/
  `@pros/index`/`@pros/implement`. It operates purely on a real git repo
  (`git diff` between two shas) plus locally-defined structural types for
  the optional verdict/objections inputs, so it's usable standalone and has
  a small dependency tree (`typescript`, for real AST parsing via the
  compiler API, is its only production dependency).
- **Risk scoring is a named, explainable, deterministic formula** (documented
  as exported constants in `packages/review/src/hunks.ts`: size score, a
  generated/lockfile penalty, a whitespace-only near-zero score, a keyword
  bonus for auth/payment/migration/concurrency-shaped paths or content, a
  no-test-coverage bonus, and bonuses when a hunk's file is named in a
  recorded verification failure or review objection) -- never a model call.
  Determinism is a hard requirement, tested directly (same inputs, two
  calls, deep-equal).
- **Gate 2's verdict and review results are now durably journaled**, not
  just returned in-memory. `packages/implement/src/pipeline.ts`'s
  `runGate2Pipeline` now appends `verify_verdict` and `review_completed`
  journal entries (loosely-typed, `journal.append({...} as any)`, following
  the exact same pattern already established for `pr_create_intent`/
  `pr_created` in the same file -- `@pros/barrier`'s `JournalEntry` union is
  intentionally NOT extended, per this project's D12 tolerant-parsing house
  style) -- appended BEFORE the early-return-on-failure checks, so a FAILING
  verdict or a blocker-laden review is recorded just as durably as a
  success. This was necessary for the review page to show "recorded fact,"
  not just whatever happened to still be in memory when a human clicks in.
  A useful side effect discovered while wiring this: `@pros/index`'s
  `rebuildIndex` already inserts EVERY journal entry (regardless of whether
  its `kind` is a member of the closed `JournalEntry` union) into the
  generic `events` SQL table before its kind-specific switch statement runs
  -- so these two new kinds were queryable via `events WHERE kind = ...`
  with zero changes to `@pros/index` itself.
- **The review page's diff always runs against the worktree allocation's
  `repo_root`, never its `worktree_path`.** A git worktree shares its parent
  repo's object database, so `baseSha`/`headSha` remain diffable in
  `repo_root` even after `git worktree remove` (M4's `reapWorktreeOnSuccess`
  deletes exactly `worktree_path`, on purpose, once a PR exists) -- using
  `worktree_path` would make the review page break for every successfully
  reaped run, which is the common case, not the exception.
- **The AST-symbol build gate is a real, separately-invoked subprocess
  script** (`packages/review/scripts/build-diagrams.ts`, run via
  `tsx`/`npx tsx`), not just an in-process function -- so "fails the build"
  is proven by actually spawning it and checking its exit code, against both
  a fixture citing real symbols (exit 0) and one citing a bogus symbol name
  (non-zero exit, no output written).
- **Honest gap, called out rather than papered over**: the architecture
  doc's "one paragraph on why" (item 2 of the review-page list) has no
  underlying recorded data source in this milestone -- Gate 2 never
  produces free-text "intent" prose. The dashboard review page uses the
  recorded verification summary as the closest honest substitute, labelled
  plainly as "verification summary," rather than fabricating an "intent"
  paragraph no component actually generated. A future milestone that wants
  a real intent paragraph needs a new, clearly-labelled-as-advisory model
  call producing one -- not invented here.

## Component status

| Component | Status | Notes |
|---|---|---|
| `@pros/graph` | **done** | `buildSessionGraph(db, runId)`. 5/5 tests, incl. the provenance test against a real rebuilt index. |
| `@pros/review` | **done** | `rankHunks`, `buildFocusChecklist`, `validateDiagramSpec` + `scripts/build-diagrams.ts` build gate. 11/11 tests, incl. the subprocess negative-symbol build-gate test. |
| `@pros/implement` verdict/review journaling | **done** | `verify_verdict`/`review_completed` now journaled unconditionally (including failure paths). 30/30 tests (27 prior + 3 new). |
| Dashboard graph page | **done** | `/runs/[runId]/graph` -- `lib/graph-data.ts` + page, a plain per-attempt timeline table with a `raw_events#{id}` provenance column and an unknown-node warning banner. |
| Dashboard review page | **done** | `/runs/[runId]/review` -- `lib/review-data.ts` + page, handling three cases (no worktree yet / worktree-but-no-PR / full PR case), risk-ranked hunks (collapsible for lockfile/generated/whitespace), focus checklist, blocker warning banner. |

### Dashboard integration details

- `packages/dashboard/lib/graph-data.ts`: `loadSessionGraph(db, runId)` (thin
  wrapper over `@pros/graph`), plus `groupNodesByAttempt`/`hasUnknownNodes`/
  `countUnknownNodes` display helpers.
- `packages/dashboard/lib/review-data.ts`: `parseLatestEventOfKind<T>(db,
  runId, kind)` (reads the highest-`seq` row of a journal kind straight out
  of `@pros/index`'s generic `events` table -- `verify_verdict`,
  `review_completed`, and `pr_created` are all readable this way with zero
  changes to `@pros/index`, because `rebuildIndex` already inserts every
  journal entry into `events` before its kind-specific switch runs);
  `getWorktreeInfo(db, runId)` (reads the `worktrees` table); and
  `computeReviewData(...)`, which calls `@pros/review`'s `rankHunks`/
  `buildFocusChecklist` **always against the worktree allocation's
  `repo_root`, never `worktree_path`** -- a worktree shares its parent's git
  object database, so `baseSha`/`headSha` stay diffable in `repo_root` even
  after M4's `reapWorktreeOnSuccess` deletes the local `worktree_path`
  directory (the common case for a successfully-shipped run). A dedicated
  test (`computeReviewData: never needs a since-deleted worktreePath`)
  proves this concretely.
- `packages/dashboard/app/runs/[runId]/graph/page.tsx` and
  `.../review/page.tsx` are both `dynamic = "force-dynamic"` server
  components, following the exact same rebuild-then-open-the-index /
  plain-HTML-inline-style conventions as the pre-existing plan/questions
  pages (no new UI dependency, no client-side JS). Linked from the run
  detail page's footer (`Session graph →` / `Review →`).
- The review page never hides a failure: if verification failed or review
  found unresolved blockers, that is shown plainly (verdict badges, a
  blocker warning banner) even though no PR exists yet in that case --
  continuing the M3 "never look healthy" invariant into Gate 2.
- Honest, undisguised gap (documented in code, and here): the architecture
  doc's "intent + risk badge -- one paragraph on why" has no underlying
  free-text data source in this milestone (Gate 2 never produces one). The
  review page shows the recorded verification summary instead, labelled
  plainly as "verification summary," rather than fabricating an "intent"
  paragraph nothing in the pipeline actually generated.

## Acceptance criteria -> tests (tracking)

| Criterion | Status |
|---|---|
| Every graph node traces to a real raw-event row | **Met.** `packages/graph/test/graph.test.ts`: "graph: every node traces to a real raw_events row (provenance invariant)" -- built against a REAL rebuilt SQLite index, not a stub. |
| A code diagram citing a symbol absent from the AST fails the build | **Met.** `packages/review/test/ast-validate.test.ts`'s subprocess test: `build-diagrams.ts` invoked as a real child process, exits 0 + writes output for a good fixture (citing real symbols in `packages/review/src/hunks.ts`), exits non-zero + writes nothing for a fixture citing `totallyBogusSymbolThatDoesNotExist`. |
| Session graph renders with zero LLM calls | **Met.** `packages/graph/test/graph.test.ts`'s zero-involvement test: no `spawnClaude`/`spawnCodex`/child_process import anywhere in `packages/graph/src`, plus a timing bound over a large synthetic table. `buildSessionGraph` only ever does one SQL SELECT + pure JSON parsing. |
| Review page risk ranking is deterministic/reproducible | **Met.** Package level: `packages/review/test/hunks.test.ts`'s determinism test. Dashboard level: `packages/dashboard/test/review-data.test.ts`'s `computeReviewData: deterministic across repeated calls with identical inputs`, against a real throwaway git repo. |
| Unknown/unparsed events surface in the UI, never look healthy | **Met.** `@pros/graph`'s `kind: "unknown"` nodes are never dropped; the dashboard graph page renders an explicit warning banner whenever any exist (`hasUnknownNodes`/`countUnknownNodes` in `lib/graph-data.ts`), continuing the M3 dashboard-health invariant. |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | Re-confirmed: no new API-billing env var introduced by any M5 package -- `@pros/graph`/`@pros/review` never touch a model session at all (by construction, not just by test). |
| `pnpm -r test` stays green for M1-M4, no regressions | **Met.** Final full-workspace run (this pass): `pnpm -r typecheck` clean across all 15 packages. `pnpm -r --no-bail test`: every package green except two ISOLATED-LOAD-SENSITIVE flakes under full-workspace concurrent test load, both in packages this milestone never touched (`packages/barrier`'s pre-existing "guardian kill-test #2" flake, already documented as a known environment-load flake in `docs/06-m3-implementation-log.md`; and one instance of `packages/cli`'s `pros answer` test, same class of poller/heartbeat-timing race under heavy concurrency). Both were re-run in isolation (`pnpm --filter @pros/barrier test`, `pnpm --filter @pros/cli test`) and passed cleanly every time; `git status` confirms neither package was touched by any M5 change. Package-by-package final counts: adapters 5, agents 7, lease 12, review 11, barrier 20 (19+1 load-flake), index 5, worktree 6, notify 9, mcp 12+1 skip, graph 5, plan 16, implement 30, dashboard 34, cli 6 (5+1 load-flake). **Total: 195 passing, 1 skipped, 0 real failures.** |

## How to view the graph and review page

```bash
export PROS_RUNS_DIR=~/.pros/runs         # same as M1-M4
export PROS_INDEX_DB=~/.pros/index.sqlite # same as M3
pnpm --filter @pros/dashboard dev          # http://localhost:3000
```

- `/runs/<runId>/graph` -- the session graph: a plain-language summary bar
  (tool counts, subagents spawned, skills invoked, files written, bash
  verbs) followed by a per-attempt timeline table. Every row's rightmost
  column is `raw_events#<id>` -- the real SQLite primary key the node was
  derived from; open `~/.pros/index.sqlite` yourself and
  `SELECT * FROM raw_events WHERE id = <id>` to see it isn't a made-up
  reference.
- `/runs/<runId>/review` -- the Gate 2 review page: verdict/review badges,
  risk-ranked hunks (lockfile/generated/whitespace hunks collapsed by
  default via `<details>`), and the focus checklist. Renders honestly for a
  run that hasn't reached Gate 2 yet, or that failed verification/review
  (no PR in that case, but the failure itself is shown, never hidden).

## How to run the tests

```bash
pnpm -r typecheck   # 15 packages, 14 with a typecheck script, all clean
pnpm -r test        # generous timeout recommended: 300000-600000ms
pnpm --filter @pros/graph test
pnpm --filter @pros/review test
pnpm --filter @pros/implement test
pnpm --filter @pros/dashboard test
```

## Known gaps

- The review page's "intent + risk badge" (architecture doc item 2, "one
  paragraph on why") has no underlying free-text "why" data source in this
  milestone -- Gate 2's pipeline never produces one. The dashboard
  substitutes the recorded verification summary, labelled plainly as
  "verification summary," rather than fabricating prose. A future milestone
  wanting a real intent paragraph needs a new, clearly-advisory-labelled
  model call that produces one.
- "New to you" (item 5 of the architecture doc's review-page list) is
  explicitly M6 scope (history index / learning loop), not attempted here.
- The AST symbol validator (`@pros/review/src/ast-validate.ts`) validates
  citations against symbols declared in ONE named source file at a time
  (function/class/interface/type/enum/variable declarations + class/interface
  members) -- it does not resolve cross-file re-exports or follow import
  chains. A diagram citing a symbol that is merely re-exported from a
  different file than the one named in the `DiagramSpec` would be
  (correctly, per the spec's own contract of "this file contains this
  symbol") reported missing; this is documented as the validator's actual
  contract, not a bug, but a future diagram-authoring UI should pick the
  file where a symbol is genuinely declared, not just re-exported.
- The dashboard's new pages are tested at the `lib/*.ts` data-layer only
  (matching this project's pre-existing dashboard test convention -- no
  sibling page.tsx anywhere in this dashboard has a rendering test, since
  there is no React-testing-library/jsdom setup in the repo). The `page.tsx`
  files themselves were manually reviewed for correctness but have no
  automated rendering test; this mirrors the existing risk profile of every
  other dashboard page in this codebase (plan, questions, runs), not a new
  gap introduced by M5.
- No CI job wires `packages/review/scripts/build-diagrams.ts` into an actual
  repository-wide "build" step (e.g. no `*.diagram.json` files exist in this
  repo outside test fixtures yet) -- the mechanism is proven end-to-end
  (real subprocess, real exit codes, real AST) but nothing in this
  milestone's scope calls for real diagram content to author today; wiring
  it into a top-level `pnpm build` or CI step is a natural, small follow-up
  once a consumer wants to actually author a code diagram.
