# ProsHarness

ProsHarness is a local software factory for Claude Code and Codex. A trigger
becomes a finding, the finding becomes a debated plan, a human approves the
plan, an implementation runs in an isolated Git worktree, and a second human
reviews the resulting draft PR. The system never merges a PR.

This is a pnpm workspace of TypeScript packages. The browser UI is one client
of the orchestration system, not the system of record.

## Start here

Read these in order when you need project context:

1. `WHAT-WE-BUILT.md` - concise system overview and design rationale.
2. `RUNNING.md` - verified install, demo seed, UI tour, CLI commands, and
   troubleshooting.
3. `docs/11-project-status.md` - current status, environment variables, gaps,
   and standing checks.
4. `docs/00-decisions.md` - settled architectural decisions and rejected
   alternatives. Read before changing the architecture.
5. `docs/03-architecture.md` - invariants, state machine, data model, and
   milestone plan.
6. `HANDOFF.md` - open work and operational hazards.

The numbered implementation logs in `docs/04-*.md` through `docs/10-*.md`
explain how each milestone was built. `docs/12-cleanup-log.md`,
`docs/13-zero-token-rework.md`, and `docs/14-design-system.md` document the
later cleanup, credential-boundary, and UI work.

## Quick commands

Requirements: Node.js 22 or newer and pnpm 11.3.0.

```bash
pnpm install
pnpm run dev             # Next dashboard at 127.0.0.1:3000
pnpm run start           # production dashboard: build then start
pnpm run test            # all workspace tests
pnpm run typecheck       # all workspace typechecks
pnpm run build           # all workspace builds
pnpm run seed:demo       # create safe demo runs under ~/.pros/
pnpm run seed:reset      # remove only demo-* data
pnpm run pros <verb>     # CLI entry point
```

Useful CLI verbs are `plan`, `answer`, `implement`, `reconcile`, and
`schedule`. Use `pnpm run pros schedule status`, without inserting `--` before
the arguments. See `RUNNING.md` for exact examples and the scheduler warning:
never run an ambient sweep against a repository you do not want modified.

The full test suite includes a small number of real-CLI acceptance tests. Give
it a generous timeout. A test that self-skips because a live CLI did not
respond is different from an actual failure.

## Architecture in one view

```text
trigger or CLI
    -> @pros/plan: finding -> Claude/Codex debate -> plan document
    -> Gate 1: durable checkpoint, no live process
    -> @pros/implement: implementation -> verification -> adversarial review
    -> deterministic orchestrator opens draft PR
    -> Gate 2: human reviews and merges outside ProsHarness
```

The durable run directory under `PROS_RUNS_DIR` contains the journal,
manifest, checkpoints, and raw model events. The journal is authoritative.
`@pros/index` builds a disposable SQLite read index from it. Never create or
update derived state by bypassing the journal.

The two human gates are the central lifecycle boundary:

```text
queued -> finding -> planning/debating -> awaiting_approval
       -> approved -> implementing -> verifying -> reviewing
       -> pr_open -> awaiting_review -> done
```

Runs can also be abandoned or paused at other durable checkpoints. A parked
run must own no live model process. `ask_human` records the checkpoint and the
barrier freezes or kills the attempt while the tool call is still in flight.

## Package map

| Package | Responsibility | Start with |
|---|---|---|
| `packages/barrier` | Durable journal, manifest, run state, checkpoints, process guardian, fenced resume | `src/barrier.ts`, `src/journal.ts`, `src/resume.ts` |
| `packages/adapters` | Spawn and parse the official `claude` and `codex` CLIs | `src/claude.ts`, `src/codex.ts`, `src/types.ts` |
| `packages/worktree` | Crash-safe Git worktree allocation and reconciliation | `src/allocator.ts` |
| `packages/plan` | Finding, plan drafting, Codex critique, debate, and Gate 1 pipeline | `src/pipeline.ts`, `src/finding.ts`, `src/debate.ts`, `src/gate1.ts` |
| `packages/implement` | Gate 2 implementation, verification, review, draft PR, and reconciliation | `src/pipeline.ts`, `src/implement.ts`, `src/verify.ts`, `src/review.ts`, `src/pr.ts` |
| `packages/lease` | Global concurrency leases and per-run token ceilings | `src/concurrency-lease.ts`, `src/token-ceiling.ts` |
| `packages/index` | Rebuildable SQLite projection of run journals | `src/rebuild.ts`, `src/schema.ts` |
| `packages/mcp` | `ask_human`, `submit_plan`, and the ExitPlanMode hook | `src/ask-human.ts`, `src/submit-plan.ts` |
| `packages/notify` | Slack-via-MCP and ntfy notification transports | `src/index.ts`, `src/wire-barrier.ts` |
| `packages/graph` | Deterministic session graph derived from raw events | `src/graph.ts` |
| `packages/review` | Deterministic risk-ranked hunks, checklist, and diagram validation | `src/hunks.ts`, `src/checklist.ts`, `src/ast-validate.ts` |
| `packages/triggers` | Linear, Slack, Granola, and local sweep signal sources with dedup/admission | `src/runner.ts`, `src/sources/` |
| `packages/schedule` | Observable polling loop for triggers, continuation, and skillrank | `src/jobs.ts`, `src/loop.ts` |
| `packages/miner` | Local Claude-history correction mining and loop proposals | `src/mine.ts`, `src/corrections.ts`, `src/loops.ts` |
| `packages/skillrank` | Offline ranked skill proposals; never auto-installs | `src/run.ts`, `src/rank.ts` |
| `packages/cli` | `pros` command-line entry points | `src/main.ts` |
| `packages/dashboard` | Next.js server-rendered UI and API routes | `app/`, `lib/`, `components/` |
| `packages/agents` | Markdown agent brief loading and validation | `src/load-brief.ts` |

## Dashboard navigation

The dashboard reads from a fresh SQLite projection on page load. Keep page
components focused on presentation and user intent; put deterministic data
shaping in `packages/dashboard/lib/` and domain behavior in the relevant
workspace package.

| Route | Purpose | Main code |
|---|---|---|
| `/` | Sessions board | `app/page.tsx`, `components/board/`, `lib/board-data.ts` |
| `/new` | Manual or ambient trigger front door | `app/new/`, `app/api/new/` |
| `/runs` | Flat run list | `app/runs/page.tsx`, `lib/list-runs.ts` |
| `/runs/[runId]` | Run overview and health | `app/runs/[runId]/page.tsx`, `lib/health.ts` |
| `/runs/[runId]/plan` | Gate 1 plan, objections, and actions | `app/runs/[runId]/plan/`, `lib/gate-actions.ts` |
| `/runs/[runId]/review` | Gate 2 verdict, diff, checklist, and PR | `app/runs/[runId]/review/`, `lib/review-data.ts` |
| `/runs/[runId]/graph` | Event-backed session graph | `app/runs/[runId]/graph/`, `lib/graph-data.ts` |
| `/runs/[runId]/questions` | Generic `ask_human` checkpoints | `app/runs/[runId]/questions/page.tsx` |
| `/loops` | Mined loop proposals | `app/loops/page.tsx`, `lib/loops-data.ts` |
| `/schedule` | Scheduler job status | `app/schedule/page.tsx`, `lib/schedule-data.ts` |
| `/skills` | Skill proposals | `app/skills/page.tsx`, `lib/skillrank-data.ts` |

Dashboard mutations must pass through the same durable domain operations as
the CLI. For example, plan approval maps to `Barrier.recordAnswer`; it must
not edit a run state or SQLite row directly. API routes should validate input,
call the domain operation, and return an honest result.

## Non-negotiable invariants

- The journal is the source of truth. SQLite is a rebuildable cache.
- A human wait is a checkpoint, never a parked live process.
- Resume the working directory from the recorded manifest and reconcile it
  with disk before allowing writes. CLI `--resume` does not restore cwd.
- Drive the official `claude` and `codex` CLIs as subprocesses. Do not replace
  them with a raw API call or a third-party subscription reimplementation.
- Do not pass API credentials into model subprocesses. In particular, model
  sessions must not receive GitHub credentials.
- The deterministic orchestrator may open a draft PR, but no code path may
  merge one. Gate 2 is a human review boundary.
- Unknown journal event kinds must surface as unhealthy in the dashboard. If
  a new event is added, update the allowlist in `packages/dashboard/lib/health.ts`
  and add coverage.
- Ambient triggers must remain deduplicated and bounded by the concurrency
  lease and token ceiling.
- Miner and skillrank output is proposal-only. They must not mutate the
  source history or install anything automatically.

## Change workflow

1. Read the relevant decision and architecture sections before changing a
   load-bearing boundary.
2. Find the domain package first. Keep the dashboard adapter thin.
3. Preserve the journal event schema and add a test for every new event or
   state transition.
4. For behavior changes, add or update the nearest package test. Prefer
   deterministic fakes for model sessions; use real CLIs only in explicit
   acceptance tests.
5. Run the narrow package test and typecheck, then the full checks when the
   change crosses package boundaries:

   ```bash
   pnpm --filter @pros/<package> test
   pnpm --filter @pros/<package> typecheck
   pnpm run typecheck
   pnpm run test
   ```

6. Inspect rendered dashboard pages with both seeded data and an empty
   `~/.pros` state. A page that returns 200 but hides an unhealthy or unknown
   journal state is a correctness bug.

Do not discard unrelated working-tree edits. Before changing a file, inspect
`git status` and `git diff`. Do not commit or push unless explicitly asked.

## Known operational gaps

These are real constraints, not reasons to weaken the invariants:

- A real headless `claude -p` implementation session may stop before making a
  commit when edit/bash permission is not already granted.
- Gate 1 to Gate 2 continuation is supervised by the polling scheduler, not a
  dedicated long-running daemon.
- Granola's live API shape is not confirmed.
- Miner Stage B, which would send personal history to a model, is deliberately
  not built.
- Skillrank uses a small offline catalog rather than a live registry.

For current truth, prefer `docs/11-project-status.md` and `HANDOFF.md` over
this summary when they disagree.
