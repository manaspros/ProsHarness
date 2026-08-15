# Handoff

**For a session with no prior context.** ProsHarness is built, running, and documented. This file is the front door: what exists, what to read, what is actually left to do.

---

## State

| | |
|---|---|
| Commit | `997f67f` on `master`, working tree clean, nothing pushed |
| Tests | 335 tests, 334 pass, 1 skip (real-CLI, self-flaking), 0 fail — `pnpm -r test` |
| Typecheck | clean, 18/18 packages — `pnpm -r typecheck` |
| Dashboard | `pnpm install && pnpm run start` → http://127.0.0.1:3000 |
| Setup required | **none** — optionally `gh auth login` for real draft PRs |

Everything in the original plan (M1–M7) is built, plus a post-M7 cleanup pass, a credential rework, and a full UI redesign.

---

## Read in this order

1. **`WHAT-WE-BUILT.md`** — what the system is, how it works, and the interesting findings. Start here.
2. **`RUNNING.md`** — start it, drive it, seed demo data, CLI verbs.
3. **`docs/11-project-status.md`** — consolidated status and the full gap list.
4. **`docs/00-decisions.md`** — 25 decisions with reasoning *and what was rejected*. Read before changing architecture; several obvious-looking ideas were already tried and killed for measured reasons.
5. **`docs/03-architecture.md`** — invariants, data model, state machine.

Per-milestone detail lives in `docs/04-…` through `docs/10-…`; the later passes are `12-cleanup-log.md`, `13-zero-token-rework.md`, `14-design-system.md`.

---

## What the system does

```
trigger → finding → plan ⇄ Codex critique → [GATE 1: you approve] →
implement (Sonnet, isolated worktree) → verify → review → draft PR → [GATE 2: you review] → you merge
```

Two human gates, nothing else. The system never merges.

UI: `/` sessions board · `/new` trigger front door · `/runs/<id>/plan` Gate 1 · `/runs/<id>/review` Gate 2 · plus runs, questions, graph, loops, schedule, skills.

CLI: `pnpm run pros <verb>` — `plan`, `answer`, `implement`, `reconcile`, `schedule`. (No `--` before args; it swallows them.)

---

## Open work, in priority order

1. **Headless permission grant.** `pros implement` driven for real reaches the Gate 2 pipeline and stops at *"verify — no commit"*: a headless `claude -p` subprocess has no edit/bash permission grant by default. Every test passes because tests drive the pipeline with fake sessions, so nothing exercised a live implementing subprocess. **This is the gap between "passes tests" and "lands a commit on your machine"** — fix it first.
2. **Gate 1 → Gate 2 daemon continuation** exists but has no long-running daemon supervising it; a scheduled job polls every 2 minutes. Fine for now, not a real daemon.
3. **Sweep scan result list is unbounded** on `/new` (24 items flat, pushes the launch button down). Cosmetic.
4. **Granola's real API shape is unconfirmed**; Linear/Slack/Granola MCP paths are wired and tested but never invoked against real accounts.
5. **Learning-loop Stage B** (LLM-written session cards) deliberately not built — it would mean sending personal history to a model. One decision away from shipping, and that decision is the user's.
6. **Skillrank catalog** is a small static offline list, not a live registry.

Full consolidated list: `docs/11-project-status.md`.

---

## Things that will bite you

- **The journal is the authority; SQLite is a rebuildable index.** Never write derived rows that bypass the journal — the demo seed deliberately goes through real pipelines for this reason.
- **A returning MCP tool call does not end a turn.** The model consumes the result and keeps writing. `ask_human` must never return success; the daemon freezes the attempt with the call in flight. This shaped the entire barrier design.
- **`--resume` does not restore the working directory.** Every resume sets cwd from the recorded manifest and reconciles against disk. Measured, not assumed.
- **Only the official CLIs spend the subscription.** Drive `claude`/`codex` as subprocesses. `env | grep -iE 'ANTHROPIC|OPENAI'` must stay empty — that emptiness is the proof, and it is asserted in the suite.
- **The model never holds a GitHub credential.** `GH_TOKEN`/`GITHUB_TOKEN` are stripped and the `gh` config dir repointed for every model spawn; only deterministic orchestrator code calls `gh`, and no path in it reaches merge. Preserve this if you touch PR code.
- **A "flaky" test may not be flaky.** One failure was written off as environment load across three milestones with contradictory diagnoses each time; it was a real guardian bug that could hand back a containment boundary pointing at nothing. When the *diagnosis* keeps changing, that is the signal.

---

## How this was built

Orchestrator-plus-subagents throughout: a milestone orchestrator per milestone, each delegating individual files to fresh Sonnet subagents, integrating, testing, and iterating. Implementation on Sonnet; the top tier reserved for planning and judgment. Continue this way — it is also the routing policy the product itself implements.

Two habits that paid off and are worth keeping:

- **Verify, don't relay.** Subagent reports were wrong more than once — a "flake" that was a real bug, and test counts off in both directions. Run the tests yourself before repeating a number.
- **Look at rendered pages.** The independent QA pass found that *every completed run displayed a red "unhealthy — do not trust this run" alarm*, because a known-journal-kinds list predated the Gate 2 pipeline. No test caught it. Screenshots did.

---

## Standing checks

- `env | grep -iE 'ANTHROPIC|OPENAI'` stays empty while everything works.
- Before any CLI version bump, replay recorded fixtures through the parser — the fixture diff is the changelog.
- Unknown events must surface in the UI. A run that silently dropped a "verification failed" event must never look healthy.
