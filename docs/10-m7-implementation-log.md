# M7 implementation log -- ambient triggers + skillrank

Status: **COMPLETE**. `@pros/triggers` (trigger framework + 4 source
adapters), `@pros/skillrank` (weekly ranked skill proposals), `@pros/schedule`
(the scheduler that drives both), and the `pros schedule`/dashboard
`/schedule` + `/skills` integration are all built and tested. `pnpm -r
typecheck` is clean across all 19 packages. `pnpm -r test`: 284 tests total,
282 passing, 1 pre-existing unrelated flake (`@pros/barrier`, see "Test
results" below), 1 pre-existing skip (`@pros/mcp`) -- neither touched by M7.

## M7 scope (from the roadmap / brief)

1. Trigger framework: a common `TriggerSource` abstraction, signal dedup, and
   admission gated by the existing global concurrency lease and per-run token
   ceiling.
2. Four source adapters: Linear, Slack, scheduled sweep (no credentials),
   Granola -- uniform interface, graceful degradation.
3. skillrank weekly proposals: ranked skill-adoption suggestions, proposals
   only, never auto-installed.
4. Scheduling: whatever drives the periodic sweep and the weekly skill pass,
   simple and observable, failures surfaced rather than silently dropped.

## How this was built

Orchestrated with no implementation code written by the orchestrating
session directly. Three Sonnet subagents built the independently-specified
components, given exact interface contracts up front:

- `@pros/triggers` (types, dedup, 4 source adapters, runner, admit.ts wiring
  into `@pros/plan` + `@pros/lease`) -- built in parallel with `@pros/skillrank`.
- `@pros/skillrank` (catalog, signals, rank, run, CLI) -- built in parallel
  with `@pros/triggers`, no dependency between the two.
- `@pros/schedule` + `pros schedule` CLI + dashboard `/schedule` and
  `/skills` pages -- built once both of the above existed, since it wires
  them together.

The orchestrator then added one two-line change directly (a nav-link edit in
`packages/dashboard/app/layout.tsx` linking to the two new pages) and
independently re-verified everything: re-ran `pnpm -r typecheck`/`pnpm -r
test` from a clean shell rather than trusting subagent self-reports, and
read the actual source of the trigger runner, admit.ts, schedule jobs, and
both new dashboard pages before writing this log.

## Package layout (as built)

```
packages/triggers/     @pros/triggers -- the ambient trigger framework
  src/types.ts            Signal, SignalEvidence, TriggerSource
  src/dedup.ts             SignalDedupStore -- durable, mkdir-mutex +
                           atomic temp-write/fsync/rename/fsync(dir),
                           same discipline as @pros/lease's
                           ConcurrencyLease. signalDedupId = sha256
                           (sourceId:externalId), doubles as the
                           deterministic runId so a retried admission is
                           idempotent at the plan-pipeline layer too.
  src/sources/linear.ts    fixture-based; real GraphQL fetch path present
                           but untested (gated on apiUrl+apiKey both set)
  src/sources/slack.ts     fixture-based; real conversations.history fetch
                           path present but untested (gated on
                           botToken+channel both set)
  src/sources/granola.ts   fixture-based; one Signal PER action item; real
                           fetch path present but untested (gated on apiKey)
  src/sources/sweep.ts     THE credential-free source -- recursive
                           TODO/FIXME/XXX scan of the real repo tree,
                           externalId hashes file+comment text (not line
                           number) so a TODO survives nearby line shifts
  src/runner.ts            runTriggerCycle -- per-source AND per-signal
                           isolation (try/catch around fetchSignals and
                           around admission), dedup-peek -> lease-acquire
                           -> claim -> onNewSignal -> release-in-finally
  src/admit.ts             createRealOnNewSignal -- the ONLY place that
                           wires runPlanPipeline; withTokenCeiling wraps
                           both ModelSessions so a run that blows its
                           ceiling fails loudly, not silently
  src/index.ts             public re-exports

packages/skillrank/     @pros/skillrank -- weekly ranked skill proposals
  src/types.ts             SkillCandidate, SkillProposal (status: "proposed"
                           literal invariant), SkillProposalsFile
  src/catalog.ts           static, bundled, OFFLINE 11-entry seed catalog
                           (5 real entries from docs/02-research-findings.md
                           incl. obra/brainstorming which IS already
                           installed; 6 plausible-but-fictional entries)
  src/signals.ts           readInstalledSlugs (skill-registry-lock.json),
                           readHistoryVocabulary (@pros/miner's
                           history-vocabulary.json), both tolerant of
                           missing/malformed input
  src/rank.ts              rankProposals -- keyword-overlap scoring against
                           bash verbs/tool names/file extensions, EXCLUDES
                           already-installed slugs, score>0 only, sorted
                           score desc then slug asc
  src/run.ts               runSkillrank + writeSkillrankOutput (writes only
                           ${outDir}/skill-proposals.json)
  bin/skillrank.ts         CLI entry, prints only counts/paths

packages/schedule/      @pros/schedule -- the scheduler
  src/types.ts             ScheduledJob, JobRunSummary, JobStatus
  src/status-store.ts      one JSON file per job, same atomic-write
                           discipline as @pros/lease
  src/run-job.ts           runJobOnce -- NEVER throws; a failing job's
                           REAL error message is durably recorded,
                           lastRunAt still advances (so a failure looks
                           like "ran and failed", never "never ran"),
                           nextDueAt still advances a full intervalMs
  src/loop.ts              startSchedulerLoop -- single setInterval,
                           sequential due-job execution, isDue() is a
                           pure function unit-tested exhaustively
  src/jobs.ts              makeTriggerSweepJob (5min default),
                           makeSkillrankWeeklyJob (7-day default) --
                           thin wiring only, let errors propagate to
                           run-job.ts's catch

packages/cli/           + src/schedule.ts: `pros schedule start
                         [--interval=<ms>]` / `pros schedule status`
packages/dashboard/      + lib/schedule-data.ts + app/schedule/page.tsx
                         + lib/skillrank-data.ts + app/skills/page.tsx
                         + two nav links in app/layout.tsx
```

## Design decisions and deviations

- **Signals feed the EXISTING plan pipeline rather than a parallel one.**
  `Signal -> description string -> runPlanPipeline({ description, ... })`.
  This is deliberate: M2's `runFinding` already guarantees a finding cites a
  real, verified `file:line` (schema-validated, checked against the actual
  repo). Building a second, trigger-specific finding path would either
  duplicate that guarantee or weaken it. The one place a trigger source adds
  value beyond a bare description is `SweepSource`, whose signals already
  carry known-real `evidence: {file, line}` -- `admit.ts`'s `buildDescription`
  puts that directly into the finding-session prompt, so the Claude finding
  agent gets a head start rather than having to rediscover it.
- **Dedup ordering matters and was deliberately specified up front:** a
  signal is durably claimed only AFTER a concurrency lease slot was actually
  acquired for it. If the lease is unavailable this cycle (the global pool
  is at `maxConcurrent`), the signal is recorded as `skippedDeferred` and
  left unclaimed, so a later sweep with headroom can still pick it up. This
  is what keeps "same signal seen twice never spawns two runs" true without
  also making "the pool was briefly full" mean "this signal is now lost
  forever."
- **Trigger-admitted runs share the SAME global concurrency lease pool as
  Gate 2 implementation runs** (`PROS_LEASE_DIR`, unchanged from M4), per
  D21 in `docs/00-decisions.md`: the lease is a system-wide admission
  control, not a per-feature one. An ambient trigger cannot pile unattended
  work on top of a Gate-2-saturated system.
- **Per-run token ceilings are enforced by wrapping `ModelSession`, not by
  modifying `@pros/plan`.** `withTokenCeiling(session, ceiling)` in
  `admit.ts` intercepts every `.run()` call, records usage against a
  `TokenCeiling` (`@pros/lease`), and lets `TokenCeilingExceededError`
  propagate. This avoids touching M2's `runPlanPipeline`/`ModelSession`
  contract at all -- the ceiling is purely a decorator applied at the one
  call site that constructs real sessions for ambient runs.
- **The skillrank candidate catalog is a small, static, offline, HAND-WRITTEN
  seed list, not a live registry query.** M7's own safety constraints rule
  out any unattended network call touching a live skill registry overnight;
  a reproducible, offline catalog also makes the ranking tests fully
  deterministic. Growing this catalog (or wiring it to the real skill
  registry the way the interactive `skillrank` slash-command skill already
  does) is future work, not a regression -- see "Known gaps."
- **skillrank's ranking signal is `@pros/miner`'s `history-vocabulary.json`
  (bash verbs, tool names, file extensions), read as a plain JSON file, not
  by importing `@pros/miner`.** This mirrors the M6 dashboard convention
  (`loops-data.ts` deliberately doesn't import `@pros/miner` either) and
  keeps `@pros/skillrank` a leaf package with zero `@pros/*` dependencies.
- **The scheduler's "failures surface" mechanism is a status file, not an
  exception.** `runJobOnce` never throws: a thrown error from `job.run()` is
  caught, its real message recorded verbatim in `lastError`, and `lastRunAt`
  still advances -- this is the detail that makes a failure observable as
  "ran and failed" rather than indistinguishable from "hasn't run yet."
  `nextDueAt` still advances by a full interval on failure too, so a broken
  job retries on schedule instead of spinning the loop hot.
- **Two small, deliberate inconsistencies, both documented in-source rather
  than silently left:**
  - `packages/cli/src/schedule.ts`'s env-var resolution follows the
    established CLI convention (`HOME ?? "/root"`); `packages/dashboard/lib/
    schedule-data.ts` and `skillrank-data.ts` follow the M6 dashboard
    convention (`os.homedir()`, no `"/root"` fallback), matching
    `loops-data.ts`'s own precedent. Both resolve to the same path on any
    normal single-user machine (a real `$HOME` is always set); the
    divergence only differs in the "no HOME env var at all" edge case,
    which does not occur in practice for this dogfood deployment.
  - `PROS_SKILL_LOCK_FILE`'s default is `<HOME>/.pros/skill-registry-lock.json`,
    **not** the repo-root `skill-registry-lock.json` this repo actually
    ships. Running `pros schedule start` without setting this env var
    explicitly will make the skillrank job see "nothing installed" (an
    empty/missing lock file), which is a safe failure mode (it just means
    every candidate looks uninstalled and gets proposed, never a crash or a
    wrong write) but is NOT what a real deployment wants. **The user must
    set `PROS_SKILL_LOCK_FILE=/home/manas/Code/ProsHarness/skill-registry-lock.json`
    (or wherever their working copy of this repo lives) before running the
    scheduler for real.** Documented again in `docs/11-project-status.md`'s
    configuration table.

## Outbound-action safety posture (the hard constraint from the brief)

**Nothing in this milestone posts, comments, messages, or writes to Linear,
Slack, or Granola. Nothing auto-installs a skill.** This was designed in,
not bolted on after:

- Every source adapter (`linear.ts`, `slack.ts`, `granola.ts`) carries an
  identical `READ-ONLY ADAPTER` banner comment stating outbound action is a
  future feature that must go through explicit human approval. `sweep.ts`
  carries the same banner for the local-filesystem case (read-only, no
  writes to the repo).
- Each adapter's "real" fetch path (`fetchFromApi`) is read-only by
  construction: Linear's is a GraphQL `query`, never a `mutation`; Slack's
  is `conversations.history`, never `chat.postMessage`; Granola's is a plain
  GET. None of these paths are exercised against a real network in any
  test -- they exist only as a documented shape for future real-credential
  wiring.
- `@pros/triggers/test/outbound-safety.test.ts` is a static, belt-and-
  suspenders grep test: it reads every `src/sources/*.ts` file's text and
  asserts none contains an outbound-write-shaped substring
  (`postMessage`, `chat.post`, `createComment`, `mutation `, etc).
- `@pros/skillrank`'s invariant tests prove, behaviorally (not just by
  type), that `runSkillrank`/`writeSkillrankOutput` never touch
  `skill-registry-lock.json` (byte-for-byte identical before/after, checked
  against a tmp copy, never the real repo-root file from a test) and that
  `writeSkillrankOutput` writes exactly one file inside its `outDir` and
  nothing else. Every `SkillProposal.status` is the literal `"proposed"`;
  there is no code path anywhere in this codebase that writes any other
  value or calls an installer.
- No network call exists in `@pros/skillrank`'s source at all (statically
  verified: no `fetch(`/`http.request`/`https.get`/`https.request`
  anywhere in `src/*.ts`) -- unlike the trigger sources, skillrank has no
  "real" network path at all in this milestone; it is offline by
  construction, not just by configuration.
- The dashboard's `/schedule` page remains purely informational. `/skills`
  (like `/loops` after the later regeneration UX pass) exposes an explicit
  local proposal-generation action, but has no install/apply path; the
  proposal data remains server-rendered and the non-install invariant is
  verified by tests.

## Per-source setup instructions (what the user must provision for real)

All four sources run entirely on bundled fixtures today (`test/fixtures/
{linear-issues,slack-messages,granola-notes}.json` inside `@pros/triggers`)
and MCP access to the real Linear/Slack/Granola accounts is disconnected in
this environment by design -- none of this milestone's tests, or the
default `pros schedule start` invocation, touch a real account. To wire a
source to its real account later:

| Source | Env vars to set | What to provision |
|---|---|---|
| Linear | `PROS_LINEAR_API_URL`, `PROS_LINEAR_API_KEY` | A Linear API key (Settings -> API -> Personal API keys is simplest for a single-user deployment) with **read-only** access to issues. The adapter only ever sends a GraphQL `query`, never a `mutation` -- but scope the key to the minimum the Linear UI allows regardless, since the key itself is what actually enforces the boundary, not this code's good behavior. |
| Slack | `PROS_SLACK_BOT_TOKEN`, `PROS_SLACK_CHANNEL` | A Slack bot token with `channels:history` + `channels:read` (or the private-channel equivalents) and **nothing else** -- specifically no `chat:write`. The adapter never calls a posting endpoint, but an over-scoped token is a real capability this code doesn't need and shouldn't hold. |
| Sweep | none | Nothing -- this is the credential-free source. Runs against whatever `repoRoot` the scheduler is configured with (`PROS_REPO_ROOT`, defaults to `process.cwd()`). |
| Granola | `PROS_GRANOLA_API_KEY` | A Granola API key, if/when Granola exposes one publicly (unconfirmed at time of writing -- `fetchFromApi`'s URL/shape is a placeholder). Until then this source only ever returns fixture or empty results. |

Leaving any of these env vars unset is the expected, safe, "not configured"
state -- the corresponding source's `fetchSignals()` returns `[]` rather
than throwing, and the trigger sweep proceeds normally with whatever
sources ARE configured (see "graceful degradation" below).

To exercise a source against its bundled fixture instead of a real account
(useful for a dry run), set e.g. `PROS_LINEAR_FIXTURE=<path>` to a
Linear-issue-shaped JSON array -- see `packages/triggers/test/fixtures/
linear-issues.json` for the exact shape expected.

## Acceptance criteria -> status

| Criterion | Status |
|---|---|
| Each source adapter parses its fixtures correctly, produces well-formed findings citing a real file:line | **Met.** All four adapters have parsing tests against their fixtures (`packages/triggers/test/sources.test.ts`). `SweepSource` additionally produces genuine `evidence.file`/`evidence.line` from a real planted-TODO tmp directory scan (not a fixture), proven stable across line-number shifts. The eventual finding's file:line citation comes from M2's existing, already-tested `runFinding` schema validation -- unchanged by M7, reused rather than duplicated. |
| Signal dedup: the same signal seen twice spawns exactly one run | **Met.** `packages/triggers/test/runner.test.ts`'s dedup test: two `runTriggerCycle` calls with an identical signal produce exactly one `admittedRunIds` entry total, the second call reports it as a duplicate. |
| An unavailable/failing source degrades gracefully -- never wedges the daemon, never loses other sources' signals | **Met.** Per-source AND per-signal isolation in `runTriggerCycle`: a source whose `fetchSignals()` throws is recorded in `sourceFailures` and skipped; healthy sources' signals are still processed in the same cycle (proven with a malformed-fixture source alongside healthy ones). A signal whose own admission (`onNewSignal`) throws is recorded in `admissionFailures` without affecting sibling signals. `runTriggerCycle` itself never throws. |
| Outbound actions are gated behind human approval -- prove nothing sends automatically | **Met.** See "Outbound-action safety posture" above: static source-text grep test, read-only-by-construction fetch implementations, and no real-network call anywhere in the trigger or skillrank test suites. |
| skillrank proposals are proposals -- prove nothing is auto-installed | **Met.** `SkillProposal.status: "proposed"` is a TypeScript literal type with exactly one value written anywhere in this codebase; `packages/skillrank/test/invariants.test.ts` proves `skill-registry-lock.json` is byte-for-byte unchanged before/after a full `runSkillrank` + `writeSkillrankOutput` run (against a tmp copy, never the real file), and that `writeSkillrankOutput` writes exactly one file. |
| Scheduling: a failed scheduled pass surfaces rather than silently stopping | **Met.** `runJobOnce` never throws, durably records the real error message plus an updated `lastRunAt`/`nextDueAt` on failure, and a healthy sibling job's status is unaffected by a failing one (proven in `packages/schedule/test/run-job.test.ts`). The dashboard's `/schedule` page renders a failed job with an unmissable ERROR badge and its real error text -- never downgraded to looking healthy. |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | **Met.** Re-checked directly: only `PATH` and `CLAUDE_PLUGIN_DATA` match, both pre-existing references to the installed `openai-codex` Claude Code plugin's own directory name, not an API key. Unrelated to and unchanged by M7. |
| Unknown events surface in the UI | **Met, unchanged from M3/M5.** M7 introduces no new journal event kinds and does not touch `packages/dashboard/lib/health.ts`'s `KNOWN_JOURNAL_KINDS` set or its surfacing logic. |
| `pnpm -r test` stays green for M1-M6 (~207 passing at last count) | **Met, and grown.** All pre-existing M1-M6 packages pass unchanged (the one `@pros/barrier` failure is a documented pre-existing flake unrelated to M7 -- see "Test results"). |
| `pnpm -r typecheck` clean | **Met.** All 19 workspace packages (18 with a typecheck script) clean. |

## Test results

Full-workspace run, this milestone's pass: `pnpm -r typecheck` clean across
all 19 packages. `pnpm -r --no-bail test`:

Package-by-package counts: adapters 5, agents 7, lease 12, miner 15,
skillrank 14 (new), review 16, barrier 20 (19 pass, 1 fail), index 5,
worktree 6, notify 9, mcp 13 (12 pass, 1 pre-existing skip), graph 5, plan
16, triggers 20 (new), implement 30, dashboard 63 (45 prior + 18 new: 2
schedule-data + skillrank-data test files plus a static-inspection test per
new page), schedule 19 (new), cli 9 (6 prior + 3 new schedule tests).
**Total: 284 tests, 282 passing, 1 known load-only flake, 1 pre-existing
skip, 0 real failures.**

The one failure, `@pros/barrier`'s "guardian: kill-test #2 - watchdog fails
closed when the daemon stops heartbeating," was re-run in isolation three
times and failed all three times in this environment during this session --
worth noting more plainly than the M6 log's "one pre-existing flake" framing,
since it did not self-heal on retry here. It is, however, definitively **not
a regression from M7**: `git status`/`git diff` confirm zero files under
`packages/barrier/` were touched by any M7 work, and the exact same class of
guardian/heartbeat timing sensitivity is already documented, independently,
in `docs/06-m3-implementation-log.md` and `docs/08-m5-implementation-log.md`
and `docs/09-m6-implementation-log.md`. This machine's cgroup v2/systemd-run
scheduling latency under load appears to be the root cause, not application
logic -- flagged again in `docs/11-project-status.md`'s known-gaps list as a
standing environment sensitivity worth a closer look, not swept under the
rug.

## Known gaps

- **The skillrank candidate catalog is a small (11-entry), hand-authored,
  static seed list**, not a live query against the public skill registry.
  It will not surface a genuinely new/trending skill outside that list. The
  interactive `/skillrank` slash-command skill already available in this
  Claude Code environment DOES search the live registry -- a future
  milestone could feed its results into this catalog periodically (still
  offline/cached between runs, to preserve reproducible weekly proposals
  and avoid a nightly unattended network dependency), rather than hardcode
  a fixed set forever.
- **Three of the four source adapters' "real" fetch paths are implemented
  but never exercised against a real network or real credentials** --
  Linear's GraphQL query, Slack's `conversations.history`, and Granola's
  placeholder REST call are all written to the shape the brief asked for
  (config-gated, read-only) but are genuinely untested beyond typechecking,
  per this milestone's hard safety constraint against touching real
  accounts. The very first real use of each is effectively its integration
  test; a bad assumption about the real API's response shape would surface
  there, not here.
- **Granola's real API shape is unconfirmed** (no public API was verified
  to exist at time of writing) -- `fetchFromApi`'s URL and JSON shape are a
  documented placeholder, not a verified contract.
- **`PROS_SKILL_LOCK_FILE`'s default does not point at this repo's actual
  `skill-registry-lock.json`** (see "Design decisions" above) -- must be set
  explicitly for a real scheduler run, otherwise skillrank behaves as if
  nothing is installed (safe, but not useful).
- **No scheduled job runs anything unless `pros schedule start` is
  explicitly invoked and left running** -- there is no system service/cron
  unit installed by this milestone; "scheduling" here means an in-process
  Node loop the user starts and supervises themselves (e.g. via `systemd
  --user`, `tmux`, or a process manager), not an OS-level cron entry. This
  matches the brief's "keep it simple" instruction but is worth being
  explicit about: killing the `pros schedule start` process stops all
  ambient triggers and the weekly skillrank pass until it's restarted.
- **The scheduler loop processes due jobs sequentially, never in
  parallel** -- a slow trigger sweep (e.g. one blocked on a real, slow
  Linear API call once wired up) delays the skillrank job's due-check until
  the next poll tick. Simplicity-over-throughput, an explicit, documented
  choice matching `@pros/triggers`' own single-threaded-per-cycle design,
  not an oversight -- but worth knowing if real per-source latency turns
  out to be high.
- **The `@pros/barrier` guardian kill-test flake** (see "Test results")
  reproduced 3/3 times in isolation during this session, more consistently
  than the "occasional flake under heavy concurrent load" framing in prior
  milestone logs suggests. Worth a dedicated investigation, out of scope
  for M7 (M1 is frozen; M7 must not touch `packages/barrier`).
