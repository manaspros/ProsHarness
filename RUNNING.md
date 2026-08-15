# Running ProsHarness

This is the "I just want to see it work" doc. For everything else (every env
var, every known gap, every milestone), read `docs/11-project-status.md`
first -- this file only covers getting it up and poking at it.

Everything here was actually run and verified while writing this doc, on
this machine, on 2026-08-15. Where something didn't fully work, it says so.

---

## 1. Install, build, start (two minutes)

```bash
cd ProsHarness
pnpm install
pnpm run start          # builds the dashboard, then starts it
```

Open **http://127.0.0.1:3000** -- bound to localhost only (Next's `-H
127.0.0.1`), never `0.0.0.0`. If you're on Tailscale, this is reachable from
your phone via `tailscale serve` or by visiting your Tailscale hostname on
port 3000 the normal way; the app itself never listens on anything but
loopback.

Root scripts (all added at the repo root, thin wrappers over
`packages/dashboard` and `packages/cli`):

| Script | Does |
|---|---|
| `pnpm run dev` | Dashboard in Next dev mode, `127.0.0.1:3000`, hot reload. |
| `pnpm run start` | Dashboard build + production start, `127.0.0.1:3000`. |
| `pnpm run pros <args>` | The `pros` CLI, no global install needed (`tsx packages/cli/src/main.ts <args>`). **Do not put `--` before the args** -- `pnpm run pros -- schedule status` silently swallows the args (confirmed broken); `pnpm run pros schedule status` (no `--`) is the form that actually works. |
| `pnpm run seed:demo` | Populates realistic demo data (below). |
| `pnpm run seed:reset` | Removes only the demo data (below). |
| `pnpm run build` / `test` / `typecheck` | Unchanged, `pnpm -r <script>` across all 19 packages. |

The dashboard is the only package with a real build step (`next build`);
everything else (CLI, pipelines, scheduler) runs straight off `tsx`, no
compile stage.

**Known pre-existing typecheck issue, not from this pass:** at the time of
writing, `pnpm -r typecheck` fails in `packages/notify` (`Cannot find name
'sendNtfy'`) because of concurrent, unrelated work in progress on
`packages/notify`/`packages/triggers`/`packages/implement/src/pr.ts`. All 18
other packages typecheck clean. If this doc is stale by the time you read
it, re-run `pnpm -r typecheck` and see whether that other work landed.

---

## 2. Seed realistic demo data

Real pages need real data. `pnpm run seed:demo` does NOT fabricate SQLite
rows -- it drives the actual `runPlanPipeline` / `runGate2Pipeline`
functions (the same ones `pros plan` / `pros implement` call), with only
the `claude`/`codex` **subprocess calls** faked (scripted responses), so the
journal, the index, the worktrees, and the git history are all produced by
real code paths, not shortcuts. This is the same pattern the project's own
`gate1-e2e.test.ts` / `pipeline.test.ts` use.

```bash
pnpm run seed:demo
```

Creates, under `~/.pros/`:

- **`demo-repo`** (+ a bare `demo-repo-origin.git`): a small, real, local git
  repo with two genuine bugs (`src/sumAll.ts`'s off-by-one loop,
  `src/parseConfig.ts`'s missing null-check). Never touches your real repos.
- **`demo-parked-gate1`**: a real finding -> plan -> Codex critique (one
  major objection accepted into a revised plan, one minor objection left as
  an accepted risk) -> `plan_finalized` -> **parked at Gate 1**, unanswered.
  Shows up on `/runs`, `/runs/demo-parked-gate1/plan` (objections + the
  Approve/Amend/Reject buttons), and its session graph.
- **`demo-completed`**: a real finding -> plan (no objections) -> Gate 1
  approved (a real `Barrier.recordAnswer` call, exactly what `pros answer`
  does) -> a real Gate 2 run: a real commit fixing `parseConfig.ts`, a real
  `verify_verdict` (pass), a real `review_completed` (approve, one
  non-blocking objection), and a real **local, stub** draft PR (via
  `LocalGhStub` -- never touches actual GitHub). Shows up on
  `/runs/demo-completed/review` (risk-ranked hunks, the diff, the draft PR
  link) and its session graph.

Every seeded run id is prefixed `demo-` -- this is what makes reset safe.
Re-running `seed:demo` is idempotent (it skips any run id that already
exists).

```bash
pnpm run seed:reset
```

Removes only `demo-*` run directories (traced via each run's own journal,
never a blanket wipe), their worktrees, the demo repo + its bare origin, and
the index db (always safe to delete -- it's a rebuildable cache). Refuses
and exits nonzero if it finds anything demo-*looking* that doesn't exactly
match the `demo-` prefix, rather than guessing.

Both scripts respect the same env vars as everything else
(`PROS_RUNS_DIR`, `PROS_WORKTREES_DIR`, `PROS_INDEX_DB`), plus
`PROS_DEMO_REPO_ROOT` if you want the demo repo somewhere other than
`~/.pros/demo-repo`.

---

## 3. Pages, verified

All render without runtime errors (200s, no error boundaries triggered),
checked against the seeded demo data above:

| Page | What it shows (with demo data) |
|---|---|
| `/runs` | Both demo runs, fence epoch, status badge, health. |
| `/runs/<id>` | Run overview, manifest, attempt list. |
| `/runs/demo-parked-gate1/plan` | Plan markdown, both Codex objections (accepted / accepted-as-risk), Approve/Amend/Reject buttons. |
| `/runs/<id>/questions` | Scoped to `ask_human`-gate checkpoints specifically (not Gate 1/2, which live on `/plan` and `/review`) -- correctly empty for both demo runs, since neither uses a plain `ask_human` checkpoint. |
| `/runs/demo-completed/review` | Risk-ranked diff hunks (`src/parseConfig.ts`), the draft PR link, the focus checklist. |
| `/runs/<id>/graph` | Session graph -- every node backed by a real `raw_events` row (finding, draft, critique, revise, implement, ultrareview, codex review, verify). |
| `/loops` | Empty by design until you run `pnpm --filter @pros/miner mine` against real Claude Code history -- correctly says so rather than erroring. |
| `/schedule` | Empty until `pros schedule start` has run at least once -- correctly says so. |
| `/skills` | Empty until `pnpm --filter @pros/skillrank run` -- correctly says so. |

Nothing 500s empty either -- every page was also checked with no data at
all (before seeding) and rendered a correct empty state, not a crash.

---

## 4. The CLI, verified against the seeded data

```bash
pnpm run pros reconcile
# worktrees: 0 finished (adopted), 0 rolled back, 2 already ok
# leases: 0 stale lease(s) freed
# pr ops: 0 adopted, 0 need manual retry, 1 already ok

pnpm run pros schedule status
# no scheduled jobs have ever run yet (statusDir=~/.pros/schedule)   <- until you run `schedule start` once

pnpm run pros answer <questionId> approve --effect=continue_within_approved_plan
# answered <questionId> (checkpoint <id>) in run demo-parked-gate1: "approve" [continue_within_approved_plan]
# (questionId is printed by seed:demo's own summary output, or read it off
#  the Plan page / the journal directly)

pnpm run pros implement <run-id>
# real invocation, real @pros/implement pipeline -- see the honesty note below

pnpm run pros implement demo-completed
# pros implement: Gate 2 has already been started or completed for run demo-completed -- refusing to double-run
```

**Honesty note on `pros implement`:** run for real (not faked) against the
freshly-approved `demo-parked-gate1`, it correctly reached the real Gate 2
pipeline, spawned a real `claude -p` subprocess, and returned cleanly:
`stopped at stage "verify" -- implementation produced no commit`. The
pipeline's own logic is working exactly as designed (no crash, no partial
state, no PR attempted) -- but a real, non-interactive `claude -p` call has
no permission grant to edit files or run `git commit` without an
interactive approval, and this codebase doesn't pass any
`--dangerously-skip-permissions`-equivalent flag, so a real headless
`pros implement` in an unattended environment is likely to stop at "verify"
rather than actually produce a fix, unless whatever launches it is itself
running with edit/bash permissions already granted (e.g. inside an already-
approved Claude Code session, which is the normal way this system is meant
to be driven). This is a real, previously-undocumented operational gap --
not something introduced by this pass, and not something fixed here. The
seeded `demo-completed` run demonstrates a full, real Gate 2 success end to
end using scripted (not live) sessions, so the pipeline's correctness apart
from this permission concern is proven -- the gap is specifically "a
non-interactive real Claude subprocess call, launched from a plain shell,
won't take repo-editing actions by default."

**`pros plan`** (not exercised for real in this pass, to avoid unnecessary
real subscription spend beyond what `pros implement` already used) --
invocation is:
```bash
pnpm run pros plan <repoRoot> "<task description>" [--run-id=<id>]
```
Expect it to take real time (a real finding + debate against two live
subprocesses) and to hit the same permission ceiling as above if the repo
work requires file edits during the finding stage (it usually doesn't --
finding is mostly read-only).

---

## 5. The scheduler / daemon

```bash
pnpm run pros schedule start [--interval=<pollIntervalMs>]
# scheduler loop started: jobs=trigger-sweep, skillrank-weekly, gate1-continuation, statusDir=~/.pros/schedule
```

Runs until killed -- not a cron job, not a system service. Supervise it
yourself (`tmux`, `systemd --user`, a process manager). `pros schedule
status` works independently, reading the same durable status files.

**Important gotcha, hit and fixed while writing this doc:** the trigger
sweep job (`SweepSource`) scans `PROS_REPO_ROOT` for signals and will
happily open real worktrees and branches against whatever repo you point it
at. Testing `pros schedule start` against this actual ProsHarness checkout
(by leaving `PROS_REPO_ROOT` unset, which defaults to `process.cwd()`)
created two real `pros/<runid>/...` branches and worktrees in this repo
within seconds -- harmless, but unwanted, and had to be cleaned up by hand
(`git worktree remove`, `git branch -D`). **Never run `pros schedule start`
with `PROS_REPO_ROOT` pointed at a repo you care about unless you actually
want the ambient sweep operating on it.** Point it at the demo repo
(`PROS_REPO_ROOT=~/.pros/demo-repo`) or a disposable scratch repo instead.

---

## 6. What needs configuring, and what degrades gracefully

Nothing in this environment is configured beyond `PROS_RUNS_DIR`-family
defaults, and the system runs correctly anyway:

- **No `PROS_GH_PR_TOKEN`** -- real draft-PR creation is unavailable;
  `pros implement` will throw a clear "PR creation unavailable"-style error
  if it ever gets far enough to need a credential (the seeded
  `demo-completed` run sidesteps this entirely via `LocalGhStub`, a
  real-local, no-network fake).
- **No `PROS_NTFY_URL`** -- phone push notifications silently no-op.
- **No Linear/Slack/Granola credentials** -- those trigger sources return
  `[]` and are skipped by the sweep, not errored.
- **`env | grep -iE 'ANTHROPIC|OPENAI'`** stays empty here, confirmed --
  everything runs on the subscription-authenticated `claude`/`codex` CLIs,
  never a raw API key.

To go further (real PRs, real notifications, real ambient triggers), see
the full env var table in `docs/11-project-status.md`.

---

## 7. Troubleshooting, from what was actually hit

- **`pnpm run pros -- <args>` prints the usage banner instead of running
  the command.** Drop the `--`: `pnpm run pros <args>`.
- **`pros schedule start` creates worktrees/branches in a repo you didn't
  expect.** See section 5 -- set `PROS_REPO_ROOT` explicitly to a scratch
  or demo repo before starting the scheduler.
- **A run shows badge "done" even though Gate 2 aborted.** "Done" on
  `/runs` means *Gate 1 is no longer parked* (answered), not "Gate 2
  succeeded" -- check the run's own page / `/review` for the actual Gate 2
  outcome.
- **`pnpm -r typecheck` fails in `packages/notify`.** Known, pre-existing,
  unrelated to this pass -- see section 1.
- **`pros implement` stops at "verify -- implementation produced no
  commit."** See the honesty note in section 4 -- expected in a
  non-interactive shell without pre-granted edit/bash permissions.
- **Port 3000 already in use.** `pnpm run dev`/`start` hardcode
  `-p 3000 -H 127.0.0.1`; edit the root `package.json` scripts if you need
  a different port.

---

## 8. What's genuinely half-wired (said plainly)

- Session-graph raw logs (`attempts/<id>/raw.log` + `provider.txt`) are
  written by the demo's fake sessions by hand -- the **real** pipelines
  (`runPlanPipeline`/`runGate2Pipeline`) don't pass `rawLogPath` today, so a
  real (non-demo) run won't populate its own session graph unless that's
  wired up. The graph code itself is real and tested; the real pipelines
  just don't feed it yet.
- `pros implement`'s real, non-interactive Claude subprocess call has no
  permission-grant story (section 4) -- functionally usable only from
  inside an already-permitted session context, not a bare terminal.
- Everything else in `docs/11-project-status.md`'s "Known gaps" section
  still applies unchanged; nothing in this pass closed any of those.
