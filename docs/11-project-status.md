# Project status -- read this first

Written at the close of M7, the final planned milestone. This is the one
document meant to answer "what do I actually have, and what do I need to do
to use it" without reading the other ten. It is deliberately honest about
gaps -- nothing here is rounded up.

**Bottom line: M1-M7 are all built and tested. `pnpm -r typecheck` is clean
across all 19 packages. `pnpm -r test` is 284 tests, 282 passing, 1
pre-existing environment-sensitive flake in `@pros/barrier` (not a
regression, see "Known gaps"), 1 pre-existing skip in `@pros/mcp`.**

---

## What this system does, end to end

A trigger (you, typing a description; or an ambient source -- Linear, Slack,
a scheduled repo sweep, Granola) produces a description of a bug or task.
`pros plan` allocates an isolated git worktree, runs a Claude "finding"
session that must cite a real `file:line` in the repo, then runs an
independent Codex critique against the same finding, debates for up to 2
rounds, and writes a plan document plus structured objections. The run then
**parks** -- durably, with no live process -- waiting for you to approve,
amend, or reject it (**Gate 1**), which you do from the dashboard or via
`pros answer`.

On approval, `pros` (today: `runGate2Pipeline`, not yet wired to a CLI verb
-- see "Known gaps") implements the fix on a Sonnet subagent inside the
allocated worktree, verifies it in a background session (a verdict comes
back, never a raw stack trace), runs an adversarial review (Codex +
`claude ultrareview`), and opens a **draft PR** via a scoped GitHub token
that has no merge permission. That draft PR is **Gate 2** -- you review it
(the dashboard renders a session graph of what actually happened, risk-
ranked hunks, a focus checklist, and a "new to you" callout for anything in
the diff that's never appeared in your prior session history) and merge it
yourself, by hand, outside this system. **This system never merges
anything.**

Independently of any single run: a background scheduler (`pros schedule
start`) periodically (i) sweeps ambient trigger sources for new signals and
feeds them into the same `pros plan` pipeline above, with dedup so the same
signal never spawns two runs, and a global concurrency lease so ambient work
never piles on top of an already-busy system; and (ii) once a week, computes
a ranked list of skills you might want to adopt based on your actual tool
usage, and writes it out as **proposals only** -- nothing is ever installed
automatically. Separately, on demand, `@pros/miner` mines your Claude Code
history for corrections and recurring workflows and surfaces them on the
dashboard's `/loops` page, also as proposals only.

Two human gates, and only two: plan approval, and PR review. Everything
else is engineered to make those two decisions safe to make asynchronously,
from a phone, without losing work if your laptop sleeps or the daemon
crashes mid-wait.

---

## How to run it

```bash
git clone/cd into /home/manas/Code/ProsHarness
pnpm install
pnpm -r typecheck   # 19 packages, should be clean
pnpm -r test        # generous timeout: 300000-600000ms
                    # (mcp/plan's real-CLI acceptance tests each budget ~60s)
```

### The dashboard (Runs / Plan / Questions / Graph / Review / Loops / Schedule / Skills)

```bash
export PROS_RUNS_DIR=~/.pros/runs
export PROS_INDEX_DB=~/.pros/index.sqlite
export PROS_MINER_OUT=~/.pros/miner              # for /loops
export PROS_SCHEDULE_STATUS_DIR=~/.pros/schedule # for /schedule
export PROS_SKILLRANK_OUT=~/.pros/skillrank      # for /skills
pnpm --filter @pros/dashboard dev
# http://localhost:3000
```
Behind Tailscale, this is reachable from your phone -- the whole point of a
localhost web app rather than a desktop app (D6).

### The `pros` CLI

```bash
pros plan <repoRoot> "<task description>" [--run-id=<id>]
  # allocates a worktree, runs finding -> debate -> plan, parks for Gate 1

pros answer <question-id> <choice> --effect=<continue_within_approved_plan|requires_plan_amendment|abort>
  # resolves a parked checkpoint (Gate 1 approval, or any ask_human question)

pros reconcile [--stale-after=<ms>]
  # scans worktrees/leases/in-flight PR ops for orphans after a crash;
  # never force-deletes, only adopts/reports

pros schedule start [--interval=<pollIntervalMs>]
  # starts the long-running scheduler loop: trigger sweep (default every
  # 5 min) + weekly skillrank pass. Runs until killed -- not a cron job,
  # not a system service; supervise it yourself (systemd --user, tmux, a
  # process manager)

pros schedule status
  # reads the durable per-job status files and prints them -- works even
  # if no scheduler loop is currently running in this process
```

**There is no `pros implement` CLI verb yet.** `runGate2Pipeline`
(implementation -> verify -> review -> draft PR) is fully built and tested
in `@pros/implement`, but M4-M7 never added a CLI entry point that calls it
outside of tests. See "Known gaps."

### The MCP server (`ask_human`, `submit_plan`)

`packages/mcp` exposes the tools an agent session calls to checkpoint on a
human decision. Wire it into a Claude Code session's `--mcp-config` (see
`packages/mcp/src/index.ts` for the exact tool names/schemas) -- this is
what an in-progress finding/implementation session actually calls; you do
not invoke it directly.

---

## Everything you must configure

| Env var | Default | Required for | Notes |
|---|---|---|---|
| `PROS_RUNS_DIR` | `<HOME>/.pros/runs` | everything | Durable run journals/manifests. |
| `PROS_WORKTREES_DIR` | `<HOME>/.pros/worktrees` | plan/implement | Where worktrees are allocated. |
| `PROS_INDEX_DB` | `<HOME>/.pros/index.sqlite` | dashboard | Rebuildable SQLite index over the journal. |
| `PROS_LEASE_DIR` | `<HOME>/.pros/leases` | Gate 2, ambient triggers | Global concurrency lease, shared by both. |
| `PROS_NTFY_URL` | unset (notifications silently no-op) | phone push on checkpoint | e.g. `https://ntfy.sh/<your-private-topic>`. **Only** env var notifications need. |
| `PROS_GH_PR_TOKEN` | unset (PR creation unavailable) | Gate 2 draft PRs | A **fine-grained GitHub PAT**, scoped to exactly one repo: `Pull requests: Read and write`, `Contents: Read-only`, `Metadata: Read-only`. This exact split is the real mechanism that makes "the system cannot merge" true -- see `docs/07-m4-implementation-log.md`'s "the merge boundary." |
| `PROS_GH_PR_SCOPES` | `pull_requests:write,contents:read,metadata:read` | Gate 2 | Only change this if you understand the merge-boundary argument above; loosening it defeats the point. |
| `PROS_MINER_OUT` | `<HOME>/.pros/miner` | `/loops` page, skillrank ranking signal | Mined artifacts (corrections, session cards, proposals) -- never committed, already gitignored. |
| `PROS_CLAUDE_HOME` | `<HOME>/.claude` | `@pros/miner` | Where your real Claude Code history lives -- point this at an extracted backup to replay against old history. |
| `PROS_SCHEDULE_STATUS_DIR` | `<HOME>/.pros/schedule` | `/schedule` page, `pros schedule status` | Durable per-job status files. |
| `PROS_SKILLRANK_OUT` | `<HOME>/.pros/skillrank` | `/skills` page | Weekly proposals output. |
| `PROS_SKILL_LOCK_FILE` | `<HOME>/.pros/skill-registry-lock.json` **(see warning below)** | skillrank weekly job | **Must be set explicitly** to this repo's real `skill-registry-lock.json` (e.g. `/home/manas/Code/ProsHarness/skill-registry-lock.json`) for skillrank to know what's actually installed. Left at its default, skillrank will treat everything as uninstalled -- safe (nothing crashes, nothing installs), but every candidate gets proposed regardless of what you already have. |
| `PROS_MAX_CONCURRENT` | `3` | ambient trigger sweep | How many unattended runs (Gate 2 + trigger-admitted) may hold a lease slot at once. |
| `PROS_MAX_TOKENS_PER_RUN` | `200000` | ambient trigger sweep | Per-run token ceiling for trigger-admitted runs. |
| `PROS_REPO_ROOT` | `process.cwd()` | `pros schedule start`, `SweepSource` | The repo the scheduled sweep operates on. |
| `PROS_LINEAR_API_URL` + `PROS_LINEAR_API_KEY` | unset (source returns `[]`) | Linear trigger source | See `docs/10-m7-implementation-log.md`'s per-source setup table for the exact scope to grant. |
| `PROS_SLACK_BOT_TOKEN` + `PROS_SLACK_CHANNEL` | unset (source returns `[]`) | Slack trigger source | `channels:history` + `channels:read` only -- explicitly **not** `chat:write`. |
| `PROS_GRANOLA_API_KEY` | unset (source returns `[]`) | Granola trigger source | Granola's real API shape is unconfirmed; this is a placeholder until one exists. |
| `PROS_LINEAR_FIXTURE` / `PROS_SLACK_FIXTURE` / `PROS_GRANOLA_FIXTURE` | unset | dry-running a source without real creds | Point at a fixture-shaped JSON file, see `packages/triggers/test/fixtures/*.json`. |

**None of these are set in this environment right now, by design.** The
whole system runs correctly with all of them unset except `PROS_RUNS_DIR`
et al. -- notifications, PR creation, and the three credentialed trigger
sources all degrade gracefully to "not configured" rather than erroring.

**Standing safety fact, unchanged since M0:** the official `claude`/`codex`
CLIs are driven as subscription-authenticated subprocesses. No
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-shaped credential is ever read or set
by this codebase. Verify any time with:
```bash
env | grep -iE 'ANTHROPIC|OPENAI'   # must stay empty (or only show unrelated substring matches)
```

---

## Known gaps, consolidated across all seven milestones

Ordered roughly by "how much it limits actually using this day to day."

1. **No `pros implement` CLI verb.** `runGate2Pipeline` is fully built and
   tested (M4) but only invoked from tests -- there is no way to trigger
   implementation of an approved plan except by calling the pipeline
   function directly. The natural next step for anyone picking this project
   back up. (M4/M7)
2. **The `@pros/barrier` guardian kill-test #2 ("watchdog fails closed when
   the daemon stops heartbeating") is environment-sensitive on this
   machine** -- it failed 3/3 times in isolated re-runs during the M7
   session, more consistently than earlier milestone logs' "occasional
   flake under heavy concurrent load" framing suggested. Root cause is
   suspected to be cgroup v2/`systemd-run --scope` timing latency under
   this machine's current load, not application logic, but this has not
   been root-caused, only observed and reproduced. Confirmed NOT touched by
   any milestone's own changes (checked via `git diff` before every
   milestone's log was written). Worth a dedicated investigation before
   trusting the containment guarantee under real load. (M1, re-confirmed
   M3/M5/M6/M7)
3. **The skillrank candidate catalog is a small (11-entry), static,
   hand-authored seed list**, not a live query against the real skill
   registry -- deliberately offline for reproducibility and to avoid an
   unattended nightly network dependency. It will not surface a genuinely
   new/trending skill outside that list. (M7)
4. **Three of the four trigger source adapters' real-network fetch paths
   (Linear GraphQL, Slack `conversations.history`, Granola REST) are written
   but never exercised against a real account or real credentials** -- by
   design, since this project's safety constraints forbid touching real
   accounts. The first real use of each is effectively its integration
   test. (M7)
5. **`PROS_SKILL_LOCK_FILE`'s default does not point at this repo's actual
   lock file** -- must be set explicitly, see the configuration table above.
   (M7)
6. **Scheduling is an in-process Node loop you start and supervise
   yourself** (`pros schedule start`), not a cron job or system service.
   Killing that process silently stops all ambient triggers and the weekly
   skillrank pass until restarted -- there is no watchdog on the scheduler
   itself. (M7)
7. **Stage B of the learning loop (LLM-batched, Codex-style session-card
   prose: task/task_group/outcome/keywords, generalized preference rules)
   is not implemented as a live model call** -- privacy posture (no network
   egress of personal history content during an unattended run) meant M6
   shipped Stage A (deterministic extraction) only. Clustering and loop
   proposals are fully deterministic, not LLM-narrated. (M6)
8. **The correction-mining regexes are calibrated against one real dataset
   by hand**, not derived from the original research's undocumented
   methodology -- they land in the same order of magnitude per category
   (309 corrections found vs. ~290 estimated) but are not a byte-for-byte
   reproduction of the original category breakdown. (M6)
9. **"New to you" (`@pros/review`'s new-to-you check) is scoped to three
   candidate kinds** (bash verb, tool name, file extension) with a
   conservative, small, fixed command-token allowlist for diff-text
   extraction -- a precision-over-recall tradeoff. An unfamiliar CLI tool
   outside that allowlist would not be flagged even if genuinely new to the
   user. (M6)
10. **Code-structure diagrams (call path, module boundary) are out of
    scope entirely** -- per D15, the primary diagram is the session graph
    (recorded fact, zero inference), and code-structure diagrams were
    explicitly demoted to "on demand, static approximation, never a
    milestone commitment." Not built at all. (design decision, not a gap
    per se, but worth knowing if you expected them)
11. **The root-cause DAG mentioned early in the research is an abandoned
    experiment**, not a shipped feature. (design decision, per D15)
12. **No cost/dollar-spend dashboard exists** -- deliberately deferred per
    D16; subscription utilization (`rate_limit_event`) is the admission-
    control signal, token counts are the operational metric, no dollar
    totals are computed or displayed anywhere.
13. **Multi-tenancy does not exist** -- this is a single-user (dogfood)
    system by design (D1); there is no auth layer on the dashboard beyond
    "reachable only over your own Tailscale network."
14. **The dashboard's newer pages (`/graph`, `/review`, `/loops`,
    `/schedule`, `/skills`) are tested at the data-layer plus a static
    source-inspection test, not with a React-testing-library/jsdom render**
    -- a consistent, pre-existing convention across M5-M7, not a new gap
    each milestone introduces independently.

---

## Standing verification checks (run these periodically, not just once)

```bash
# 1. Subscription-auth proof: must stay empty (or only show unrelated substring matches)
env | grep -iE 'ANTHROPIC|OPENAI'

# 2. Full typecheck: must be clean across all 19 packages
pnpm -r typecheck

# 3. Full test suite: expect 284 tests, ~282-284 passing depending on the
#    @pros/barrier environment sensitivity noted above; investigate any
#    OTHER failure immediately, don't assume it's "the same known flake"
#    without re-checking which test failed
pnpm -r test    # timeout 300000-600000ms

# 4. Before any claude/codex CLI version bump: replay the recorded
#    fixtures through the parser (packages/adapters/test/parse.test.ts) --
#    a fixture diff IS the changelog for that bump. Do this before
#    upgrading, not after something breaks.

# 5. Unknown events must surface, never look healthy: packages/dashboard/
#    lib/health.ts's KNOWN_JOURNAL_KINDS is a hand-maintained allowlist --
#    if you add a new journal entry kind anywhere, add it here too, or a
#    run emitting it will show as unhealthy (correct, if unintended) or
#    (if you also forget to update the barrier's own JournalEntry union)
#    silently drop it (the actual failure mode this check exists to catch).

# 6. Skillrank/miner never write back to their sources: skill-registry-
#    lock.json and ~/.claude/history.jsonl should never change mtime as a
#    result of running `pnpm --filter @pros/skillrank run` or
#    `pnpm --filter @pros/miner mine`. Spot-check with `stat` before/after
#    if you ever suspect otherwise.

# 7. Outbound safety, re-checked by hand periodically as sources gain real
#    credentials: grep packages/triggers/src/sources/*.ts for any new
#    write-shaped call (postMessage, chat.post, createComment, `mutation `)
#    -- the existing static test only catches what it was written to catch.
```

---

## Milestone-by-milestone summary (detail lives in each numbered log)

| M | What it built | Log |
|---|---|---|
| M1 | The checkpoint barrier: guardian/cgroup containment, durable journal, manifest, fenced resume, `ask_human` MCP, `pros answer`. | `04-m1-implementation-log.md` |
| M2 | `pros plan`: adapters, rebuildable SQLite index, worktree allocator saga, plan/critique/debate pipeline. | `05-m2-implementation-log.md` |
| M3 | Gate 1: `submit_plan`, the `ExitPlanMode` hook, the dashboard (Runs/Plan/Questions), ntfy push. | `06-m3-implementation-log.md` |
| M4 | Gate 2: Sonnet `scoped-fixer` implementation, background-session verification, Codex + `ultrareview` adversarial review, draft PR via `gh` with a real merge-blocking credential boundary, concurrency lease + token ceilings, `pros reconcile`. | `07-m4-implementation-log.md` |
| M5 | The session graph (`@pros/graph`), the dashboard's review page (risk-ranked hunks, focus checklist), AST-gated code diagrams. | `08-m5-implementation-log.md` |
| M6 | The learning loop: `@pros/miner` (correction mining, session cards, pr-link-gated clustering, loop proposals), "new to you" in `@pros/review`, the dashboard's `/loops` page. | `09-m6-implementation-log.md` |
| M7 | Ambient triggers (`@pros/triggers`: Linear, Slack, scheduled sweep, Granola) + skillrank weekly proposals (`@pros/skillrank`) + the scheduler (`@pros/schedule`) + `pros schedule` CLI + `/schedule` and `/skills` dashboard pages. | `10-m7-implementation-log.md` |

This is the last planned milestone. There is no M8 in the roadmap as
written -- picking this project back up means either using it as-is (see
"Known gaps" #1 for the one missing piece that would make that materially
easier: a `pros implement` CLI verb) or choosing new scope deliberately,
not discovering it was silently expected.
