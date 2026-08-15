# M3 implementation log - Gate 1 (plan approval)

Status: **IN PROGRESS.** This file is updated incrementally as work lands, per
the orchestration brief -- if the session is cut off, this file (not the
orchestrator's transcript) is the source of truth for what is actually done.

## M3 scope (from the roadmap, docs/03-architecture.md M3 row)

`submit_plan`, `PostToolUse` hook on `ExitPlanMode`, dashboard Runs/Plan/
Questions, ntfy push over Tailscale. Explicitly NOT in scope: implementation
sessions, verification, adversarial review, draft PRs (M4); session graph /
review page (M5); learning loop (M6); ambient triggers (M7).

## M3 acceptance criteria -- tracking

| Criterion (verbatim from the roadmap/brief) | Status |
|---|---|
| Kill the daemon mid-wait; the run still resumes | pending |
| Plan editing changes the document without restarting the run | pending |
| Hook payload fixture-tested and never the sole source of plan truth | pending |
| ntfy push failure does not wedge a run or drop a question | pending |
| Fence epoch: stale pre-approval result cannot reach a post-approval stage | pending |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | pending (expected met -- inherited from M1/M2's standing-check test) |
| Unknown/unparsed events must surface in the UI | pending |
| `pnpm -r test` stays green for M1 and M2 -- no regressions | baseline confirmed green before M3 work started: 7 packages, all passing except 2 real-live-CLI acceptance tests that legitimately skip under load (documented in docs/05-m2-implementation-log.md) |

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
   without-restart, fence-epoch-rejects-stale, ntfy-failure-does-not-wedge).
   Not started.

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

## What the user must configure manually

- **ntfy endpoint:** set `PROS_NTFY_URL` (e.g. `https://ntfy.sh/<your-private-topic>`
  or a self-hosted ntfy instance reachable over your Tailscale network, e.g.
  `http://100.x.x.x/<topic>`). If unset, notifications are a no-op (logged,
  never thrown) -- the system remains fully functional without it, per the
  "a failed push must never wedge a run" requirement extended to "never
  configuring it must not wedge a run" either.
- **Tailscale:** this system does not configure or depend on Tailscale
  itself; it only assumes that if you want push notifications to reach your
  phone without public exposure, you point `PROS_NTFY_URL` at an ntfy
  instance reachable via your own Tailscale network. No code here manages
  Tailscale.
- (Filled in further as round 2/3 land -- dashboard port/run instructions
  land here once built.)

## Known gaps

(Filled in as work completes -- if this session ends before M3 is fully
done, an honest list of what's left goes here, not a claim of completion.)
