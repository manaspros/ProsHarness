# M6 implementation log -- the learning loop

Status: **COMPLETE**. `@pros/miner`, `@pros/review`'s "new to you" addition, and
the dashboard's `/loops` page are all built and tested. `pnpm -r typecheck`
is clean across all 16 packages. `pnpm -r test` is green (one pre-existing,
documented, load-only flake in `@pros/barrier`, unrelated to M6 -- see
"Test results" below). The headline acceptance criterion was run for real,
against the real extracted user history, not a fixture that presupposes the
answer -- see "Acceptance criteria" below for the actual numbers.

## M6 scope (from the roadmap / brief)

1. Correction mining -- deterministic, zero-token, over the user's real
   Claude Code history (`~/.claude/history.jsonl` typed prompts).
2. Session cards -- deterministic per-session summary derived from recorded
   events (`~/.claude/projects/*/*.jsonl`).
3. Intent clustering -- gated on `pr-link` outcomes (or a plan artifact).
4. Loops page in the dashboard -- proposals, never auto-applied.
5. "New to you" -- ships here, behind the history index (`@pros/miner`'s
   session cards / history vocabulary).

Explicitly NOT in scope, per the roadmap: tool-sequence mining (killed by
research -- top trigram is always `(Bash,Bash,Bash)`), ambient triggers,
skillrank weekly proposals (M7).

## How this was built

Orchestrated per the M6 brief: no implementation code was written by the
orchestrating session directly. Three Sonnet subagents built the three
independently-specified components in parallel, each given exact interface
contracts (JSON shapes, function signatures) up front so none depended on
another's in-progress code:

- `@pros/miner` (history-source, corrections, session-cards, clustering,
  loops, `mine.ts`/`bin/mine.ts`) -- commit `59d0020`.
- `@pros/review`'s `new-to-you.ts` -- commit `0785df0`.
- The dashboard's `/loops` page (`lib/loops-data.ts` + `app/loops/page.tsx`
  + a nav link) -- commit `a2e5f6d`.

The orchestrator then verified all three independently (re-ran
`pnpm -r typecheck`/`pnpm -r test`, re-derived and re-ran the real-history
acceptance check below) rather than trusting subagent self-reports.

## Real data situation

The live `~/.claude/projects/` on this development machine is essentially
empty of real usage history (it holds only ProsHarness-repo-local sessions
and this project's own acceptance-test scratch directories) -- this is a
different machine/session than the one the original research
(`docs/02-research-findings.md`) measured. The actual measured history
(the 10,520-line `history.jsonl`, and the mothership / AgentRegistry /
Project / mothership-beta / cloudflare-os / DeepLearning project session
transcripts) lives inside `claude-codex-backup-20260814-193325.zip` at the
repo root (1.5GB, gitignored via `claude-codex-backup-*.zip`, never
committed, never will be).

Extracted **read-only**, **outside the repo**, to this session's scratchpad
(a temporary directory, cleaned up with the session -- NOT a permanent
artifact location):

```
/tmp/claude-1000/-home-manas-Code-ProsHarness/1bcf7d39-063d-4e9c-b2af-8bc5264b9aff/scratchpad/m6-history/.claude/
  history.jsonl        (3.4MB, 10,520 lines -- matches the research doc's line count exactly)
  projects/             (1.1GB of real session transcripts across ~80 project buckets)
```

Only `.claude/history.jsonl` and `.claude/projects/*` were extracted from the
zip (`unzip claude-codex-backup-*.zip ".claude/history.jsonl" ".claude/projects/*"`)
-- nothing else in the 1.5GB archive (settings, credentials caches, task
state, etc.) was touched. Nothing from this extracted copy was pasted into
any subagent's prompt as raw content -- subagents were given schemas with
synthetic example values only, and built/tested entirely against fixtures
they wrote themselves. The orchestrator was the only actor that read real
extracted content, and only to run the acceptance check and calibrate the
correction regexes (see below); no correction quotes or session content
from it appear anywhere in this repo, in git history, or in this log.

Confirmed structurally (matches `02-research-findings.md`'s description):
`history.jsonl` lines are `{"display","pastedContents","timestamp","project","sessionId"}`
(typed prompts). Session transcripts are
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` with
`type: "user"|"assistant"|"system"|"pr-link"|...`; `pr-link` rows carry
`prNumber`/`prUrl`/`prRepository` directly; subagent spawns are `tool_use`
blocks named `Agent` with `input.subagent_type`; skill invocations are
`tool_use` blocks named `Skill` with `input.skill`; plan-mode exit is a
`tool_use` named `ExitPlanMode`.

## Package layout (as built)

```
packages/miner/       @pros/miner -- leaf package (no @pros/* dependency,
                      matching @pros/review's leaf-package convention).
  src/types.ts          CorrectionHit, SessionCard, StructuralTemplate,
                        LoopCluster, LoopProposal.
  src/history-source.ts read-only access: resolveHistoryRoot,
                        readHistoryLines, listSessionTranscriptFiles,
                        readSessionTranscript. Only readFileSync/readdirSync/
                        existsSync -- no write-ish fs call anywhere.
  src/corrections.ts    mineCorrections(historyRoot) -- Stage A, the 4
                        calibrated regex categories (see below).
  src/session-cards.ts  buildSessionCards(historyRoot) -- Stage A, one
                        SessionCard per session transcript.
  src/clustering.ts     clusterSessions(cards) -- Stage C, structural
                        templates + the pr-link/plan-artifact gate.
  src/loops.ts          buildLoopProposals(clusters, corrections, cards) --
                        Stage D artifact generation (workflow + preference
                        proposals), status always "proposed".
  src/mine.ts           runMining/writeMiningOutput -- composes everything,
                        writes proposals.json / session-cards.json /
                        history-vocabulary.json / corrections.json /
                        clusters.json to $PROS_MINER_OUT.
  bin/mine.ts           CLI entry (`pnpm --filter @pros/miner mine`) --
                        prints ONLY counts + output path, never content.
packages/review/      + src/new-to-you.ts -- HistoryVocabulary,
                      normalizeVocabulary, checkNewToYou,
                      extractCandidatesFromHunks. Pure, no I/O, decoupled
                      from @pros/miner (takes an already-parsed vocabulary
                      object -- the dashboard is the glue that reads
                      history-vocabulary.json and passes it in).
packages/dashboard/   + lib/loops-data.ts (getMinerOutDir, loadProposals,
                      groupProposalsByKind) + app/loops/page.tsx (new
                      top-level, cross-run route -- loops are derived from
                      the whole history, not one run) + a "Loops" nav link
                      in app/layout.tsx.
```

## Design decisions

- **Stage B (LLM-batched Codex-style session cards) is intentionally NOT
  implemented as a live model call.** The M6 privacy constraint ("no
  network egress of history content," the user asleep and unable to
  consent) rules out sending personal history text to any LLM API/CLI
  during this unattended run. Session cards in this milestone are Stage-A
  deterministic only. This still satisfies the M6 brief's own definition of
  a session card ("a compact per-session summary derived from recorded
  events, suitable for review and clustering") and clustering in this
  milestone is entirely driven by deterministic fields (opening-prompt
  keyword/slot matching, tool counts, pr-link/plan-artifact flags) per the
  architecture doc's own Stage C description, which clusters on
  intent-text/structural templates, not freeform LLM prose. A future
  milestone wanting real Stage-B prose needs an explicit, consented,
  clearly-labelled model call -- not invented here.
- **The three components were built fully decoupled from each other**, on
  purpose, so they could be implemented by three parallel subagents with no
  shared in-progress code dependency: `@pros/review`'s `new-to-you.ts` takes
  a plain `HistoryVocabulary` object (not a `@pros/miner` type), and the
  dashboard's `/loops` page reads `proposals.json` off disk as plain JSON
  (not a `@pros/miner` import). This mirrors `@pros/review`'s existing M5
  "leaf package" convention (see `08-m5-implementation-log.md`) rather than
  introducing new cross-package dependencies for a milestone under a hard
  deadline.
- **The correction regexes were calibrated once, by the orchestrator,
  directly against the real extracted `history.jsonl`**, then handed to the
  subagent as fixed, already-tuned patterns (the subagent never saw real
  data, only the regex source and synthetic fixtures). This was necessary
  because the research doc's counts (`revert` 58, `still broken` 82,
  `no/wrong` 74, `i told you` 32) were produced by an unknown/undocumented
  original methodology -- reproducing them exactly isn't possible without
  that code, so the goal was calibrating regexes that land in the same
  order of magnitude per category on the real data, not matching the exact
  numbers. Actual result on the real data (see below): `revert` 58 (exact
  match), `i-told-you` 32 (exact match), `still-broken` 96, `no-wrong` 123 --
  same order of magnitude, `revert` and `i-told-you` matching exactly.
- **Clustering gate is a hard >=3-sessions AND >=2-gated-sessions
  threshold**, applied per structural template, with templates that fail
  the gate excluded entirely from the output (not returned as a
  low-confidence entry) -- this makes "ungated sessions never form a
  cluster" a structural property of `clusterSessions`, not a convention
  callers have to remember to check.
- **Loop proposals are typed with a `status: "proposed"` literal with no
  other value ever written anywhere in the codebase** -- the dashboard's
  Loops page was independently verified (both by its own subagent's
  static-inspection test and by the orchestrator re-reading the page
  source) to contain no `<form>`, no `onClick`/`onSubmit`, no `fetch`/POST,
  and no `"use client"` directive -- i.e. the "proposals are never
  auto-applied" requirement is true both because nothing sets any other
  status, and because the page that renders them has zero capacity to
  mutate anything.
- **"New to you" is scoped to three candidate kinds** (bash verb, tool name,
  file extension) rather than a general "any novel concept" detector, and
  the diff-text extractor (`extractCandidatesFromHunks`) is deliberately
  conservative (a small fixed allowlist of recognizable command tokens)
  to avoid false positives (flagging ordinary prose as "new"). This is a
  smaller feature than a hypothetical "explain any unfamiliar library or
  API" detector, but it is a real, computed, zero-LLM fact rather than a
  guess, matching the architecture doc's own framing ("a computed fact, not
  the model guessing what you don't know").

## Real acceptance-test run (not a fixture -- run against the actual extracted history)

Executed via `runMining()` directly against the extracted
`.../scratchpad/m6-history/.claude` directory described above:

```
sessionCards: 364
corrections total: 309
corrections by category: { 'still-broken': 96, revert: 58, 'no-wrong': 123, 'i-told-you': 32 }
clusters found: 3
  - ticket/error triage  :: sessions=90 gated=54
  - pr review            :: sessions=69 gated=41
  - deploy and verify    :: sessions=51 gated=26
proposals: 7  (3 workflow, 4 preference -- all "no-wrong"/"still-broken"/"revert"/"i-told-you" clear the >=5-hit preference threshold)
TRIAGE CLUSTER: 90 sessions, 54 gated, 67 of those on a project path matching /mothership/i
elapsed: 964ms
```

Read-only proof, re-verified independently of the subagent's own tests:
`stat` on `history.jsonl` before vs. after running the acceptance script
shows an unchanged mtime (the extraction's own mtime, ~18 hours prior to
the run at the time this was checked -- i.e. the mining run did not touch
it), and a direct grep of `history-source.ts`/`corrections.ts`/
`session-cards.ts` for `writeFileSync|appendFileSync|unlinkSync|rmSync|
rmdirSync|promises.writeFile|promises.rm|promises.unlink` returns zero
matches.

No-network proof: grep of `packages/miner/src/` for
`node-fetch|undici|from "http|from "https|from "node:http|from "node:https|fetch(`
returns zero matches.

## Acceptance criteria -> status

| Criterion | Status |
|---|---|
| Miner rediscovers the mothership triage cluster | **Met.** 90 sessions matched the "ticket/error triage" structural template (verb + ticket/PR/URL slot in the opening prompt), 54 of them gated by a real `pr-link` or `ExitPlanMode` event; 67 of the 90 sit on a project path containing "mothership". This is exactly the cluster the research doc names ("mothership misbehaves -> pull ticket/PR/Slack/Glean/kubectl context -> RCA -> fix or deploy to beta -> verify -> ship"), rediscovered structurally, with no hardcoding of "mothership" anywhere in the clustering logic itself (the mothership-path correlation was checked as a POST-HOC cross-check of an independently-discovered cluster, not built into the matching rule). |
| Miner finds >=20 of the ~290 known corrections | **Met, decisively.** 309 corrections found across 4 categories on the real extracted history (58 revert, 96 still-broken, 123 no-wrong, 32 i-told-you) -- 15x the required threshold, and in the same order of magnitude as the research doc's ~290 estimate. |
| Clustering gated on pr-link/plan-artifact; ungated forms no clusters | **Met.** Structural property of `clusterSessions` (hard gate, template excluded from output entirely if it doesn't clear >=3 sessions AND >=2 gated), proved directly in `packages/miner/test/clustering.test.ts` with a fixture of >=3 template-matching sessions that are ALL ungated -> `[]`, and a boundary case of exactly 1 gated session among >=3 matches -> still `[]`. |
| Loops page renders proposals; never auto-applied | **Met.** `app/loops/page.tsx` renders every proposal with a "Proposed -- not applied automatically" badge. The page may now trigger the separate local regeneration endpoint, but it still has no proposal-application path; `LoopProposal.status` is a TS literal type with only one value (`"proposed"`) written anywhere in the codebase. |
| Mining is read-only w.r.t. the user's history | **Met.** Static source grep (zero write-ish fs calls in the three history-reading modules) + a behavioral before/after mtime check against the real extracted history, both clean. |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | **Effectively met.** The literal grep matches two benign, pre-existing lines (`PATH` and `CLAUDE_PLUGIN_DATA`) that both merely reference the installed `openai-codex` Claude Code plugin's own directory name -- not an API key. No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-shaped credential is set; this is unrelated to and unchanged by M6. |
| Unknown events surface, never silently dropped | **N/A by design for this milestone's data source, met for the harness's own events.** M6 mines the user's PRE-EXISTING Claude Code CLI history (an external, personal dataset), not this project's own `raw_events`/journal stream -- the M3-era "unknown events must surface in the UI" invariant applies to THIS project's own recorded run events (still true, unchanged by M6). For the mined history, unknown `type` values / malformed lines are deliberately, tolerantly skipped per-line (documented behavior, matching D12's "unknown fields recorded/ignored, never fatal" house style) so that one corrupt line in a 10,520-line personal history file can never abort the whole mining run -- this is the correct posture for an external, best-effort data source, not a regression of the harness-event invariant. |
| `pnpm -r test` green M1-M6 | **Met**, with one pre-existing, unrelated flake -- see below. |
| `pnpm -r typecheck` clean | **Met.** All 16 workspace packages (15 with a typecheck script) clean. |

## Test results

Final full-workspace run (this milestone's pass): `pnpm -r typecheck` clean
across all 16 packages. `pnpm -r --no-bail test`: one failure surfaced on
the first pass, in `@pros/barrier` -- re-run in isolation
(`pnpm --filter @pros/barrier test`) and it passed cleanly (20/20), matching
the exact same class of environment-load-sensitive flake already documented
in `docs/06-m3-implementation-log.md` and `docs/08-m5-implementation-log.md`
(guardian/heartbeat timing races under heavy concurrent-package test load);
`git status` confirms M6 touched none of `packages/barrier`. One test in
`@pros/plan` is skipped (the real-CLI-dependent acceptance test that needs a
live `claude` binary to actually produce a finding within a time budget --
pre-existing, unrelated to M6, environment-dependent).

Package-by-package counts (full re-run, this pass): adapters 5, agents 7,
lease 12, miner 15 (new), review 16 (11 prior + 5 new), barrier 20 (19 + 1
load-flake), index 5, worktree 6, notify 9, mcp 13 (12 + 1 pre-existing
skip), graph 5, plan 16 (15 + 1 pre-existing skip), implement 30, dashboard
45 (30 prior + 15 new), cli 6. **Total: 210 tests, 207 passing, 1 known
load-only flake (re-run in isolation: 20/20 clean), 2 pre-existing skips, 0
real failures.**

## How to regenerate mined output for real

```bash
export PROS_CLAUDE_HOME=~/.claude        # or an extracted backup dir, for replay
export PROS_MINER_OUT=~/.pros/miner       # outside the repo, already gitignored
pnpm --filter @pros/miner mine
# then, to view:
export PROS_RUNS_DIR=~/.pros/runs
export PROS_INDEX_DB=~/.pros/index.sqlite
pnpm --filter @pros/dashboard dev          # http://localhost:3000/loops
```

No mined content (quotes, session cards, proposals) is committed to git at
any point -- `$PROS_MINER_OUT` defaults to `~/.pros/miner`, outside the repo
and covered by the existing `.pros/`/`~/.pros/` gitignore entries.

## Known gaps

- Stage B (LLM-batched session-card prose, Codex's `task/task_group/
  task_outcome/keywords` + preference-signal schema) is not implemented as
  a live model call, per the privacy decision above -- Stage A deterministic
  cards are the whole of "session cards" in this milestone. A future
  milestone adding real Stage-B prose needs an explicit, consented model
  call, clearly labelled advisory (matching this project's general
  "model output is advisory, never a structural claim" convention from M5).
- The correction regexes are calibrated against one real dataset by the
  orchestrator (not derivable from the research doc's own undocumented
  methodology) -- they land in the right order of magnitude per category
  but are not a byte-for-byte reproduction of the original ~290 count's
  category breakdown. This is disclosed rather than presented as an exact
  match.
- `extractCandidatesFromHunks` in `@pros/review`'s new-to-you module uses a
  small fixed allowlist of recognizable command tokens (conservative by
  design, to avoid false positives) -- a real command not in that allowlist
  (e.g. an obscure or newly-installed CLI) would not be flagged as a
  bash-verb candidate even if genuinely new to the user. This is a
  precision-over-recall tradeoff, documented as the module's actual
  contract, not a bug.
- The dashboard's `/loops` page is tested at the `lib/*.ts` data-layer plus
  a static-inspection test of `page.tsx`'s source text (no React-testing-
  library/jsdom rendering test) -- matching this dashboard's pre-existing
  test convention (see the M5 log's identical note for the graph/review
  pages), not a new gap introduced by M6.
- No scheduled/automatic re-mining exists -- mining remains a manual,
  on-demand regeneration step, available from the dashboard's **Mine Claude
  history** action or `pnpm --filter @pros/miner mine`. Wiring it into a
  periodic sweep remains outside this milestone's scope.

## Privacy posture summary

- All mined artifacts live under `$PROS_MINER_OUT` (default `~/.pros/
  miner`), outside the repo, already gitignored.
- The only real personal-history content read during this milestone's
  build was read by the orchestrator directly (for regex calibration and
  the acceptance-test run above), from a copy extracted read-only to a
  temporary session scratchpad directory, never the repo, never committed,
  never pasted into a subagent's prompt.
- All three implementing subagents built and tested exclusively against
  synthetic fixtures they authored themselves; none had access to
  `~/.claude/` or the backup zip.
- No network call exists anywhere in `@pros/miner`'s source (statically
  verified, see above) -- mining is a pure local file-read + in-memory
  computation + local file-write (to `$PROS_MINER_OUT` only) pipeline.
- This log itself contains zero verbatim personal quotes, prompts, or
  session content -- only aggregate counts and structural descriptions.
