# ProsHarness docs

A local software factory over the Claude Code and Codex **subscriptions**. Trigger → finding session → Claude and Codex argue to a plan → you approve in a browser → implementation in an isolated worktree → draft PR → you review with a diagram of what actually happened. Then it learns how you work and proposes loops back to you.

Read in this order:

| Doc | What it is |
|---|---|
| [`00-decisions.md`](00-decisions.md) | Every settled decision, with the reasoning and what was rejected. Start here. |
| [`01-m0-results.md`](01-m0-results.md) | What we measured on the real CLIs. All fact, no inference. |
| [`02-research-findings.md`](02-research-findings.md) | Evidence behind the decisions: OMP/prime, vibe-kanban, ref.tools, the learning loop, the skills landscape. |
| [`03-architecture.md`](03-architecture.md) | The implementable design: invariants, data model, state machine, milestones. |
| [`04-m1-implementation-log.md`](04-m1-implementation-log.md) | M1 complete: the checkpoint barrier -- guardian/cgroup containment, durable journal, manifest, fenced resume, `ask_human` MCP, `pros answer` CLI. |
| [`05-m2-implementation-log.md`](05-m2-implementation-log.md) | M2 complete: `pros plan` -- adapters, rebuildable SQLite index, worktree allocator saga, plan/critique/debate pipeline. |
| [`06-m3-implementation-log.md`](06-m3-implementation-log.md) | M3: Gate 1 -- `submit_plan`, the `ExitPlanMode` hook, the dashboard, ntfy push. |
| [`07-m4-implementation-log.md`](07-m4-implementation-log.md) | M4 complete: Gate 2 -- Sonnet `scoped-fixer` implementation, background-session verification (verdict only), Codex+`claude ultrareview` adversarial review (a skill), draft PR via `gh` with a real merge-blocking credential boundary, concurrency lease + token ceilings, `pros reconcile`. |
| [`08-m5-implementation-log.md`](08-m5-implementation-log.md) | M5 complete: the session graph (`@pros/graph`, zero-LLM, every node traces to a real `raw_events` row), the dashboard's review page (`@pros/review` -- deterministic risk-ranked hunks, focus checklist) with a build-time AST symbol gate for code diagrams, and durable `verify_verdict`/`review_completed` journaling. |
| [`09-m6-implementation-log.md`](09-m6-implementation-log.md) | M6 complete: the learning loop -- `@pros/miner` (deterministic correction mining + session cards + pr-link/plan-artifact-gated intent clustering + loop proposals), `@pros/review`'s "new to you" vocabulary check, and the dashboard's read-only `/loops` page. Verified against the real, extracted `history.jsonl`: 309 corrections found, the mothership triage cluster rediscovered (90 sessions, 54 gated). |
| [`10-m7-implementation-log.md`](10-m7-implementation-log.md) | M7 complete: ambient triggers -- `@pros/triggers` (Linear/Slack/scheduled-sweep/Granola source adapters behind a uniform interface, durable signal dedup, gated on the global concurrency lease + per-run token ceilings), `@pros/skillrank` (offline, ranked, never-auto-installed weekly skill proposals), `@pros/schedule` (the observable scheduler that drives both), `pros schedule` CLI, and the dashboard's read-only `/schedule` and `/skills` pages. |
| [`11-project-status.md`](11-project-status.md) | **Read this first if you're picking the project back up.** The whole-project status doc: what the system does end to end, how to run every piece, every env var you must configure, every known gap across all seven milestones consolidated in one place, and the standing verification checks. |

## The three facts the whole design rests on

1. **The official CLIs spend the subscription; third-party harnesses do not.** `claude -p` emits `rateLimitType: "seven_day"` - the real weekly pool. Prime and OMP bill per token from "extra usage" and get there by replaying your OAuth token with a spoofed client fingerprint. Measured, not argued.

2. **A run waiting on a human must own no live process.** Every parked-process design dies to laptop sleep, auth expiry, or an MCP timeout ceiling. Checkpoint and resume instead - and the daemon enforces it, because a returning tool call does not stop a model.

3. **`--resume` does not restore the working directory.** Tested: a session resumed from the wrong directory operates on the wrong tree while its memory insists otherwise. Every resume sets cwd from the manifest.

## Build order

M1 is the checkpoint barrier and it ships alone. Everything else assumes a run can be safely parked and resumed; if that is false, nothing above it works. If it holds, the rest is ordinary work.
