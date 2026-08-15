# M3 implementation log - Gate 1 (plan approval)

Status: **COMPLETE.** `pnpm -r test` is green (see "How to run the tests"
below for the exact counts observed), `pnpm -r typecheck` is clean across all
9 packages, and all 8 acceptance criteria in the table below are met. This
file is updated incrementally as work lands, per the orchestration brief --
if the session is cut off, this file (not the orchestrator's transcript) is
the source of truth for what is actually done.

## M3 scope (from the roadmap, docs/03-architecture.md M3 row)

`submit_plan`, `PostToolUse` hook on `ExitPlanMode`, dashboard Runs/Plan/
Questions, ntfy push over Tailscale. Explicitly NOT in scope: implementation
sessions, verification, adversarial review, draft PRs (M4); session graph /
review page (M5); learning loop (M6); ambient triggers (M7).

## M3 acceptance criteria -- tracking

| Criterion (verbatim from the roadmap/brief) | Status |
|---|---|
| Kill the daemon mid-wait; the run still resumes | **Met.** `packages/plan/test/gate1-e2e.test.ts`, `"Kill the daemon mid-wait; the run still resumes"` -- parks a run via the real `runPlanPipeline`, then opens THREE successive fresh `Barrier` objects against the same on-disk `runDir` (no in-memory state reused across any of them), proving `parked` -> `recordAnswer` -> `claim` -> `resume` -> (still-`resuming` on a third fresh attach) is recoverable purely from disk. |
| Plan editing changes the document without restarting the run | **Met.** `packages/plan/test/gate1.test.ts`'s existing synthetic-setup test, PLUS `packages/plan/test/gate1-e2e.test.ts`'s `"Plan editing changes the document without restarting the run"`, which proves the same property against a run that arrived at `parked` via the real pipeline: `plan.md` changes, checkpoint stays `parked`, fence epoch unchanged, no `attempt_started`/`resuming`/`consumed` entries. |
| Hook payload fixture-tested and never the sole source of plan truth | **Met** (round 1 work, unchanged this pass). `packages/mcp/test/exit-plan-mode-hook.test.ts`'s `"the hook payload alone can never park a run, and parkForGate1 alone is sufficient without the hook ever firing"`. |
| ntfy push failure does not wedge a run or drop a question | **Met.** `packages/notify/test/barrier-integration.test.ts` (round 2, against a synthetic `parkForGate1` call) PLUS `packages/plan/test/gate1-e2e.test.ts`'s `"Gate 1 parks the run after plan_finalized, with a notification fired..."`, which wires the REAL pipeline's `runPlanPipeline({ ntfyUrl: "http://127.0.0.1:1" })` end to end and asserts the whole pipeline (finding+debate+park+notify) resolves in well under 8s despite the guaranteed-unreachable ntfy target. |
| Fence epoch: stale pre-approval result cannot reach a post-approval stage | **Met.** `packages/barrier/test/barrier.test.ts` kill-test #6 (synthetic) PLUS `packages/plan/test/gate1-e2e.test.ts`'s `"Fence epoch: a stale pre-approval result cannot reach a post-approval stage"`, which parks via the real pipeline, records a `requires_plan_amendment` answer (bumping the fence), then asserts `barrier.fence.check(epochBeforeAnswer, ...)` throws `StaleFenceError`. |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | **Met.** `packages/plan/test/debate.test.ts`'s `"standing check: no ANTHROPIC_*/OPENAI_*-shaped API-billing credential env var is set"`, which runs automatically alongside every new test file added this round (test/*.test.ts glob) -- not duplicated, just confirmed still passing. |
| Unknown/unparsed events must surface in the UI | **Met.** `packages/dashboard/test/health.test.ts` (round 2, synthetic `RebuildReport`s) PLUS `packages/plan/test/gate1-e2e.test.ts`'s `"Unknown/unparsed events surface, never look healthy"`, which appends a malformed line and an unrecognized-type line to a real run's `attempts/synthetic/raw.log`, runs the real `@pros/index` `rebuildIndex`, and asserts both show up in `rawLogParseIssues` (statuses `malformed` / `unknown_type`) -- the same data `@pros/dashboard`'s `lib/health.ts` `rebuildHealthIssues`/`isHealthy` consume, asserted directly against `RebuildReport` here (see "Design decisions" below for why `@pros/dashboard` itself was NOT added as a test dependency of `@pros/plan`). |
| `pnpm -r test` stays green for M1, M2, and M3 -- no regressions | **Met.** See "How to run the tests" below for the exact counts from the final run of this pass. |

## Orchestration plan

Work is being built by fresh Sonnet subagents in rounds, each briefed with
exact file paths and interfaces (no subagent invents architecture). Rounds:

1. **Gate 1 core** (sequential, foundational): `@pros/barrier` extensions
   (`checkpoint_requested.gateType`/`planRef`, new `plan_edited` and
   `hook_payload_received` journal entry kinds, `Barrier.parkForGate1()` for
   parking a run with no live attempt/guardian, `Barrier.onParked()` hook),
   the `submit_plan` MCP tool (`@pros/mcp`), the `ExitPlanMode` `PostToolUse`
   hook script + fixtures (`@pros/mcp`), and the plan-edit-without-restart
   helper (`@pros/plan`). In progress.
2. **Notify + dashboard** (parallel, depend on round 1): `@pros/notify` (ntfy
   client + `Barrier.onParked` wiring), `@pros/dashboard` (Next.js Runs/Plan/
   Questions pages + API routes). Not started.
3. **Integration + acceptance tests + docs** (sequential, depends on rounds
   1-2): wires `packages/plan/src/pipeline.ts`'s `runPlanPipeline` to actually
   park at Gate 1 after `plan_finalized` (calling `parkForGate1` + firing an
   ntfy notification) -- this is the concrete "Gate 1 wiring end to end" item
   -- plus the headline acceptance tests (kill-daemon-mid-wait, plan-edit-
   without-restart, fence-epoch-rejects-stale, ntfy-failure-does-not-wedge,
   unknown-events-never-look-healthy). **Done** -- see
   `packages/plan/test/gate1-e2e.test.ts` and the "Round 3" design-decisions
   subsection below.

## Design decisions made so far

- **`submit_plan` reuses `Barrier`'s existing checkpoint machinery rather than
  building a parallel one.** The `checkpoint_requested`/`parked`/`answered`
  journal entries already model exactly what Gate 1 needs: a durable
  intent, a manifest snapshot, and an answer with a declared effect
  (`continue_within_approved_plan` / `requires_plan_amendment` / `abort`) that
  maps directly onto approve / amend / reject. Rather than inventing a
  second state machine, `checkpoint_requested` gained an optional `gateType:
  "ask_human" | "plan_approval"` and `planRef` field, and `submit_plan` is
  structurally identical to `ask_human` (never resolves with a value the
  model could act on; the daemon -- not the tool -- ends the attempt).
- **Two distinct parking paths, because M2's plan pipeline has no live
  attempt to freeze.** `ask_human`/`submit_plan`, called *from inside* a live
  agent session, go through the existing guardian-quiesce path unchanged
  (zero risk to M1's 11 kill-tests). But `pros plan`'s pipeline
  (`packages/plan/src/pipeline.ts`) runs `finding`/`debate` as one-shot
  `ModelSession.run()` calls with no `Barrier`/`Guardian`/attempt tracking at
  all -- by the time a plan is `plan_finalized`, there is nothing left
  running to freeze. `Barrier.parkForGate1()` is an additive method that
  performs the same durable-intent -> manifest-snapshot -> `parked` sequence
  but skips guardian quiescence (there is nothing to quiesce), used by the
  pipeline integration in round 3.
- **The `ExitPlanMode` hook is corroboration, never authority, by
  construction, not by convention.** `recordHookPayload()` has no code path
  that can create or transition a checkpoint -- it only ever appends a
  `hook_payload_received` journal entry, which `run-state.ts`'s reducer
  stores in a separate `hookPayloads` array that has zero influence on
  `RunState.checkpoints`. A run reaches `parked` (Gate 1) exclusively via
  `submit_plan`/`parkForGate1`. This is proven by a test that parks a run via
  `parkForGate1` with the hook payload never recorded at all, and a second
  test showing a hook payload recorded against a run where no checkpoint was
  ever requested produces no checkpoint/parked state whatsoever.
- **Plan editing is a pure document mutation, not a run transition.**
  `editPlanDocument()` appends a `plan_edited` journal entry and rewrites
  `plan.md` atomically, touching neither the fence epoch nor any
  attempt/checkpoint state -- there is no `attempt_started`/`resuming`
  entry anywhere in the journal as a result of an edit. This is the direct
  mechanism behind the "plan editing changes the document without
  restarting the run" acceptance criterion.

### Round 3 (this pass): wiring `runPlanPipeline` to actually park at Gate 1

- **`runPlanPipeline` now parks at the very end, straight-line, no
  crash-recovery in between.** After `plan.md`/`objections.json` are written
  (unchanged from M2), the pipeline opens a `Barrier` for the run, wires
  `wireNtfyNotifications(barrier, { url: opts.ntfyUrl })`, and calls
  `barrier.parkForGate1({...})` with a deterministic
  `idempotencyKey = \`gate1-${runId}-v${debate.finalPlan.version}\`` -- a
  crash-and-retry of the WHOLE pipeline for the same run/version cannot mint
  a second Gate 1 checkpoint, because `parkForGate1` itself already treats a
  replayed `idempotencyKey` as a no-op that returns the original
  `checkpointId`.
- **`PlanPipelineResult` gained `checkpointId`, `questionId`, and `parked`.**
  `questionId` specifically is read back from `barrier.getState()` AFTER
  `parkForGate1` returns, rather than trusting the locally-generated
  `randomUUID()` -- on a genuine idempotent replay, `parkForGate1` returns
  the ORIGINAL checkpoint (and thus the original `questionId`, minted on the
  first, non-replayed call), which is not the same value the retry's own
  `randomUUID()` call produced. Reading it back from state is what makes
  `result.questionId` always the value `pros answer <questionId>` actually
  needs, even after a retried pipeline call.
- **`pros plan`'s CLI output now prints the checkpoint id AND the question
  id**, with an explicit "run: pros answer \<questionId\> ..." reminder --
  `pros answer` looks a checkpoint up by `questionId` (via
  `findRunForQuestion`, scanning parked checkpoints across all runs), not by
  `checkpointId`, so printing only the checkpoint id would have left the CLI
  output useless for actually resolving Gate 1.
- **`@pros/notify` is now a real (non-workspace-test-only) dependency of
  `@pros/plan`.** This is the one new production dependency edge introduced
  by this round; `@pros/index` was added as a devDependency of `@pros/plan`
  for the acceptance test's health-check assertion only (see below) -- it is
  never imported from `packages/plan/src/*`.
- **`@pros/dashboard` was deliberately NOT added as a test dependency of
  `@pros/plan`**, even though acceptance-test item 5's literal wording asks
  to assert against `@pros/dashboard`'s `lib/health.ts`. A UI package
  becoming a dependency (even dev-only) of a backend package is a backwards
  layering edge, and the brief explicitly offered the alternative: factor an
  equivalent assertion directly against `@pros/index`'s `RebuildReport`.
  `packages/dashboard/lib/health.ts`'s `rebuildHealthIssues`/`isHealthy` are
  themselves thin, direct wrappers around `RebuildReport.rawLogParseIssues`/
  `.truncatedRuns` (see that file's own doc comment) -- asserting
  `rawLogParseIssues.length > 0 => unhealthy` against the real
  `rebuildIndex()` output, as `gate1-e2e.test.ts`'s last test does, is the
  same claim without the layering violation. `packages/dashboard/test/
  health.test.ts` (round 2, unchanged) already covers the wrapper functions
  themselves against synthetic `RebuildReport`s.
- **Non-goal, called out explicitly per the brief: no crash-recovery inside
  `runPlanPipeline` between `plan_finalized` and `parked`.** If the process
  dies between opening the `Barrier` and `parkForGate1` completing, a retry
  of the whole pipeline (same `runId` and, critically, the same resulting
  plan `version`) is safe (idempotent, see above) -- but nothing today
  automatically re-invokes the pipeline after a crash; the operator has to
  re-run `pros plan` by hand. See "Known gaps" below.

## What the user must configure manually

- **ntfy endpoint:** set `PROS_NTFY_URL` (e.g. `https://ntfy.sh/<your-private-topic>`
  or a self-hosted ntfy instance reachable over your Tailscale network, e.g.
  `http://100.x.x.x/<topic>`). If unset, notifications are a no-op (logged,
  never thrown) -- the system remains fully functional without it, per the
  "a failed push must never wedge a run" requirement extended to "never
  configuring it must not wedge a run" either. Confirmed this pass:
  `PROS_NTFY_URL` is the ONLY env var notifications need -- `sendNtfy` reads
  it directly, and `runPlanPipeline`'s new `ntfyUrl` option is a pass-through
  that, left `undefined`, falls back to it automatically. `pros plan`'s CLI
  does NOT have its own `--ntfy-url` flag -- it relies entirely on the
  environment variable, which is the simpler, single-user-appropriate
  choice (one more flag nobody would realistically vary per-invocation).
- **Tailscale:** this system does not configure or depend on Tailscale
  itself; it only assumes that if you want push notifications to reach your
  phone without public exposure, you point `PROS_NTFY_URL` at an ntfy
  instance reachable via your own Tailscale network. No code here manages
  Tailscale.
- **`PROS_RUNS_DIR`** (all CLI commands and the dashboard) and
  **`PROS_WORKTREES_DIR`** (`pros plan` only) -- both default to
  `<HOME>/.pros/{runs,worktrees}` if unset. `PROS_INDEX_DB` (dashboard only)
  defaults to `<HOME>/.pros/index.sqlite`. Set these consistently across
  every `pros` CLI invocation and the dashboard process so they all agree on
  where a run's state actually lives.

## How to run the dashboard

```bash
export PROS_RUNS_DIR=~/.pros/runs        # optional, this is the default
export PROS_INDEX_DB=~/.pros/index.sqlite # optional, this is the default
export PROS_NTFY_URL=https://ntfy.sh/<your-private-topic>  # optional
pnpm --filter @pros/dashboard dev
```

This starts a Next.js dev server on the framework default port, **3000**
(`next dev` was not passed a `-p`, so http://localhost:3000). The dashboard
reads runs via `@pros/index`'s rebuildable SQLite index
(`packages/dashboard/lib/config.ts`'s `getIndexDbPath()`) and, for a single
run's live state, via `@pros/barrier`'s `loadRunState` directly against
`PROS_RUNS_DIR/<runId>` -- there is no separate daemon process; the
dashboard is a read-only view over the same on-disk journals `pros`
CLI commands and `runPlanPipeline` write to.

## How to run the tests

```bash
pnpm -r typecheck   # all 9 packages, clean
pnpm -r test        # generous timeout recommended: 300000-600000ms
```

Final run of this pass: **101 passing, 1 skipped, 0 failing**, across 9
packages (`adapters` 5, `barrier` 20, `index` 5, `worktree` 6, `notify` 9,
`mcp` 12 pass + 1 skip, `plan` 16, `cli` 3, `dashboard` 25).

Slow/flaky-under-load tests, called out so a failure there isn't mistaken
for a regression:
- `packages/mcp/test/*.test.ts`'s `"acceptance: real claude CLI -- ask_human
  drives the real barrier to a clean parked state"` -- a genuinely live,
  real-CLI acceptance test with a 60s budget; documented (docs/04) as
  legitimately skipping under load rather than failing. Skipped in this
  pass's final run.
- `packages/plan/test/finding.test.ts`'s (well, `test/*.test.ts`'s)
  `"acceptance: real claude CLI finds the seeded off-by-one..."` -- same
  category, also a real-CLI 60s-budget test; it happened to PASS in this
  pass's final run (13.6s), but is not guaranteed to under load, per M2's
  log.
- `packages/barrier/test/guardian.test.ts`'s kill-test #2 (watchdog) was
  observed to fail ONCE, transiently, when run concurrently with every other
  package's test suite in the same `pnpm -r test` invocation (cgroup scope
  creation took >5s under that load); it passed cleanly both alone and in
  the final full `pnpm -r --no-bail test` run reported above. Documented
  here as a known environment-load flake, not a regression introduced by
  this pass -- no code in `@pros/barrier` was touched (out of scope, see
  Constraints).
- Everything else in the 101 passing is fast (well under 1s each, aside from
  the notify package's deliberate-timeout tests in the tens-of-ms to ~200ms
  range).

## Known gaps

Everything in this brief's scope was completed and is exercised by the
tests listed in the acceptance-criteria table above. Being honest about what
is explicitly NOT covered, called out as non-goals in the brief itself:

- **No crash-recovery inside `runPlanPipeline` between `plan_finalized` and
  `parked`.** If the process dies after `debate` finishes but before
  `parkForGate1` completes (e.g. mid-`Barrier.open`, mid-notification-wiring,
  or mid-`parkForGate1` itself), nothing today automatically retries the
  pipeline. A human has to re-run `pros plan` with the same `--run-id`; that
  retry IS safe (the deterministic `idempotencyKey` means it cannot mint a
  second Gate 1 checkpoint, and `runFinding`/`runDebate` re-running against
  the same worktree/description is a documented, accepted cost of this gap
  rather than a correctness bug) -- but the daemon does not do this for you
  yet. This is a real, explicitly-scoped-out gap for a future milestone.
- **The dashboard has no auth.** Fine for the documented single-user,
  localhost-only deployment model (docs/00-decisions.md D1), but worth
  restating plainly: anyone who can reach the dashboard's port can read run
  contents and (via its API routes) submit answers. Not a concern for a
  single operator on their own machine/Tailscale network; would need
  addressing before any multi-user or public-network deployment.
- **`pros` has no first-class `pros approve`/`pros reject` verbs.** Gate 1
  resolution goes through the existing generic `pros answer <questionId>
  <choice> --effect=<effect>` command (e.g. `pros answer <id> approve
  --effect=continue_within_approved_plan`), not a dedicated
  `pros approve <id>`/`pros reject <id>` pair. This was a deliberate reuse
  of the existing mechanism (per round 1's design decision that `submit_plan`
  reuses `Barrier`'s checkpoint machinery rather than a parallel one) --
  ergonomic sugar commands are a nice-to-have, not attempted here since the
  brief's acceptance criteria are all satisfiable through `pros answer`
  as-is.
- **No `--ntfy-url` CLI flag** -- see "What the user must configure
  manually" above; `PROS_NTFY_URL` alone is the supported configuration
  surface.
