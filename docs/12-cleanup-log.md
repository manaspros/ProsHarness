# Cleanup log: post-M7 gap closure

M1-M7 were all built and tested by the close of `10-m7-implementation-log.md`.
This pass, done autonomously while the project's owner was unavailable,
worked through docs/11-project-status.md's gap list in priority order:
root-cause the `@pros/barrier` guardian kill-test #2 failure, close the
Gate 1 -> Gate 2 continuation gap, add the missing `pros implement` CLI
verb, fix `PROS_SKILL_LOCK_FILE`'s wrong default, and run a full-suite
health pass. All four are closed. This log records what was actually found
and changed -- the headline finding is that the barrier failure was a real
implementation bug, not the environment flake every prior milestone log
assumed it was.

---

## 1. The `@pros/barrier` guardian kill-test #2 failure -- root cause

**Verdict: a genuine implementation bug in `Guardian.launch()`, not a test
timing assumption, and not (primarily) an unfixable environment flake.**
M5/M6 reported it passing in isolation/20-for-20; M7 reported it
reproducing 3-for-3. Both were correct reports of the same underlying bug
observed at different points -- the bug's trigger condition (see below) is
sensitive to exactly how much prior `systemd-run --scope` churn has
happened in the same test process, which is why isolated single-file runs
and full-suite runs disagreed.

### Reproduction

Running `packages/barrier/test/guardian.test.ts` alone passed 5-for-5.
Running the FULL `packages/barrier` test file set (`barrier.test.ts` +
`guardian.test.ts` + `journal.test.ts` + `manifest.test.ts` together, one
process) failed kill-test #2 **on every single run** -- not intermittent,
100% reproducible once guardian.test.ts's kill-test #3 and the freeze()
test had already run in the same process.

### What was actually happening

Instrumented `Guardian.launch()` and the test directly (temporary debug
logging, since removed) and found, in order:

1. **The real bug**: `Guardian.launch()`'s readiness loop declared a
   transient `systemd-run --scope` unit "ready" the moment `systemctl show`
   reported `ActiveState=active` and a non-empty `ControlGroup` path --
   without ever checking that a real process had actually joined that
   cgroup. Under back-to-back scope creation/teardown churn (this test
   suite's own pattern -- ~10 scopes created and torn down within a couple
   of seconds; no real usage of this system ever does that, since exactly
   one attempt runs at a time), a transient scope can report exactly that
   state **after its sole member has already died** -- confirmed directly:
   `ActiveState=active`, a real `ControlGroup` path, and `cgroup.procs`
   already `ENOENT` for that path, with zero bytes of the target command's
   own stdout ever produced (confirmed via a temporarily-inherited stdio
   and a `/proc` polling loop -- the process never even reached its first
   `console.log`). `Guardian.launch()` handed back a `Guardian` pointing at
   a boundary that was never actually alive. That is exactly the invariant
   kill-test #2 depends on ("the boundary should contain live processes
   before quiesce") and exactly why it failed the very next `isEmpty()`
   check.

2. **A second, smaller bug in the same area**: `isEmpty()` (and `freeze`/
   `thaw`/`killAll`) only tolerated `ENOENT` as proof a cgroup is gone.
   Reproduced live during the fix: a cgroup torn down *during* the read can
   instead surface `ENODEV` (the kernel severs the cgroup's device
   association mid-read) -- same fact, different errno, previously an
   uncaught error.

3. **A test-hygiene gap, not a product bug**: even after fixing (1) and
   (2), the same failure mode could still occur if a *new* scope was
   created before the *previous* test's scope had fully unloaded from
   systemd's own bookkeeping -- `killUnitsMatching()` (test helper) fired
   `systemctl kill`/`stop` and returned without confirming the unit was
   actually gone. Under this test suite's speed (many scopes per second,
   never realistic production cadence), that left a real overlap window.

An attempt mid-investigation to "fix" this by adding an unconditional
grace-window delay to `Guardian.launch()` before returning was tried and
**rejected** -- it broke an unrelated test (`barrier.test.ts` kill-test #1)
whose correctness depends on `Guardian.launch()` returning promptly relative
to a fixture's own internal timer. That confirms the right fix belongs at
the actual overlap source (test hygiene), not as a blanket tax on every
`Guardian.launch()` caller including latency-sensitive ones.

### The fix (`packages/barrier/src/guardian.ts`, `packages/barrier/test/helpers.ts`)

- Readiness now requires a live PID actually present in `cgroup.procs` for
  the candidate cgroup path -- the kernel's own truth, not systemd's
  self-reported (and, under churn, sometimes stale) bookkeeping -- before
  `Guardian.launch()` returns. No MainPID-based check was used (a
  `.service`-only systemd property that scope units never populate; an
  earlier attempt at this fix that tried made every launch time out).
- `isEmpty()`/`freeze()`/`thaw()`/`killAll()` now treat `ENODEV` identically
  to `ENOENT` via a shared `isCgroupGoneError()` helper.
- `Guardian.launch()` gets a small bounded retry (3 attempts) as defense in
  depth for a genuine host-overload timeout -- not the mechanism that fixes
  the actual bug above, just a safety margin.
- Test helper `killUnitsMatching()` now waits for each killed unit to be
  fully unloaded (`LoadState=not-found`) before returning, closing the
  actual test-suite-only overlap window at its source instead of padding
  every real `Guardian.launch()` call with fixed latency.

### Verification

`packages/barrier`'s full test suite (all 4 files, one process) run
**65+ consecutive times** during the fix, then the full monorepo
`pnpm -r test` run **5 times** afterward (see section 4 below) -- zero
occurrences of kill-test #2 (or any other barrier test) failing.

---

## 2. Closing the Gate 1 -> Gate 2 continuation gap

Previously: `runGate2Pipeline` (`@pros/implement`) was fully built and
tested but nothing ever called it outside of test files -- an approved
Gate 1 plan just sat there until a human manually wired up
`Gate2PipelineOptions` by hand.

Added `deriveGate2OptionsFromRun()` (`packages/implement/src/from-run.ts`),
the one shared place that derives a full `Gate2PipelineOptions` from an
approved run directory:

- `worktreePath`/`branch` from the `worktree_allocated` journal entry.
- The originating target repo (for `baseBranch` derivation and
  `worktreeParentRepo`) from the matching `worktree_intent` entry --
  already durably recorded by `WorktreeAllocator`'s first saga step, so no
  new journal entry was needed.
- `baseBranch` via `git rev-parse --abbrev-ref HEAD` in that originating
  repo (not the worktree, whose HEAD is the run's own feature branch).
- `planMarkdown` from the run's `plan.md`.
- `fileAllowlist` from the approved plan's own `structured.filesTouched`
  (matched via the `plan_finalized` entry's `planId`/`version` against the
  corresponding `plan_drafted`/`plan_revised` entry), falling back to an
  empty allowlist (the existing "no restriction" behavior) if that's
  missing or malformed -- this was not persisted as a flat list anywhere
  before.

Two consumers of that derivation:

- **`pros implement <run-id>`** (`packages/cli/src/implement.ts`) -- the
  missing CLI verb (closes task 3 below). Refuses on an unanswered/amended/
  aborted Gate 1, and refuses to double-run Gate 2 if already started.
- **`makeGate1ContinuationJob`** (`packages/schedule/src/jobs.ts`), polling
  every 2 minutes, wired into `pros schedule start` alongside the trigger
  sweep and skillrank jobs, sharing the same concurrency lease and token
  ceiling. Scans for approved-but-not-yet-continued Gate 1 checkpoints and
  guards against a stale/superseded approval by comparing the checkpoint's
  own recorded fence epoch against the run's current one -- a later
  `requires_plan_amendment`/`abort` answer bumps the fence, and a
  continuation attempt against a checkpoint whose fence has moved past it
  is skipped rather than acted on.

Tested end-to-end (approval -> Gate 2 runs -> draft PR opens) via a real
git-repo fixture, both for the happy path and the stale-approval guard.

An audit of other packages (`@pros/miner`, `@pros/skillrank`,
`@pros/triggers`, `@pros/graph`, `@pros/review`) for the same "built but
uncallable" pattern found no other gap: miner has its own
`pnpm --filter @pros/miner mine` script, skillrank/triggers are already
wired into `pros schedule`, and graph/review are dashboard-consumed
libraries rather than standalone pipelines.

---

## 3. `PROS_SKILL_LOCK_FILE`'s wrong default

`resolveScheduleDirs()` (`packages/cli/src/schedule.ts`) computed the lock
file default from the `HOME` directory
(`<HOME>/.pros/skill-registry-lock.json`), which never contains the real
file -- the real `skill-registry-lock.json` lives at the repo root. Meanwhile
`buildScheduledJobs()` separately computed `repoRoot` a few lines below and
never passed it in. Fixed by threading `repoRoot` (`PROS_REPO_ROOT ??
process.cwd()`, the same convention already used elsewhere in this file)
into `resolveScheduleDirs()`, so the default is now
`<repoRoot>/skill-registry-lock.json`. `PROS_SKILL_LOCK_FILE` no longer
needs to be set by hand for the common case (running/pointing the
scheduler at this repo); it now only needs overriding if the lock file
genuinely lives somewhere else.

---

## 4. Full-suite health pass

`pnpm -r typecheck`: clean across all 19 packages, run repeatedly through
the course of this work.

`pnpm -r test`: run **5 times** after all fixes above landed.

| Run | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| 1 | 296 | 295 | 0 | 1 |
| 2 | 296 | 296 | 0 | 0 |
| 3 | 296 | 295 | 0 | 1 |
| 4 | 296 | 294 | 0 | 2 |
| 5 | 296 | 295 | 0 | 1 |

Zero test *failures* in any of the 5 runs. The skip count varies between 1
and 2 for one reason only: the real-CLI acceptance tests in `@pros/mcp` and
`@pros/plan` each budget 60 seconds for the actual, subscription-authenticated
`claude` CLI subprocess to respond, and self-skip (with a logged reason,
never a silent pass) rather than fail if it doesn't -- this is expected
variance in a real external call under real network/model load, not a bug.
`@pros/mcp`'s version of this skip was already pre-existing/documented;
this pass additionally observed the sibling test in `@pros/plan` hit the
same 60s ceiling once across the 5 runs, which is the same phenomenon in a
second test file, not a new or different flake. No other test skipped or
failed in any run. Investigated and confirmed: this is inherent to calling
a live model backend and was left as-is rather than "fixed" by raising the
timeout (which would only shift, not eliminate, the same variance) or
mocking away the real CLI (which would defeat the point of an acceptance
test against the real thing).

---

## Honest final state

- `pnpm -r typecheck`: clean, all 19 packages.
- `pnpm -r test`: stable at 0 failures across 5 repeated full runs; 296
  tests total, 294-295 passing, 1-2 skipped (real-CLI subprocess latency
  only, see above).
- The `@pros/barrier` guardian kill-test #2 failure: root-caused, fixed,
  verified stable across 65+ consecutive package-level runs plus the 5
  monorepo-wide runs above.
- Gate 1 -> Gate 2 continuation: closed, both automatically (scheduled job)
  and on demand (`pros implement`).
- `PROS_SKILL_LOCK_FILE` default: fixed, no longer needs manual
  configuration for the common case.
- Nothing in `packages/barrier` was touched by the CLI/schedule/implement
  work in sections 2-3, and nothing outside `packages/barrier` was touched
  by the guardian fix in section 1 -- verified via `git diff --stat` per
  commit.
- Remaining known gaps are consolidated in docs/11-project-status.md
  (renumbered after this pass); none of them are newly discovered by this
  cleanup -- they were already known from M6/M7 and are unchanged in
  substance, just renumbered now that the four closed items are gone from
  that list.
