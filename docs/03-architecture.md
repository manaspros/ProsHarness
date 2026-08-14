# Architecture

Stack: **TypeScript end to end.** Node daemon + `pros` CLI + Next.js dashboard + SQLite (`better-sqlite3`). One language, one process model, no Python bridge. The mining work is JSONL and SQL, which TypeScript handles fine.

---

## The one invariant everything else follows from

> **A run that is waiting on a human owns no live process group.**

Every human wait is a **checkpoint**. When the human answers, the orchestrator starts a **new** CLI invocation with `--resume` and injects the decision.

This deletes the whole failure class around parked subprocesses: laptop sleep, auth expiry, MCP client timeout ceilings, orchestrator restart, PID reuse. It is what every hosted product does for human-scale waits.

### The checkpoint is daemon-enforced, not tool-enforced

The naive version of this is wrong, and it is worth stating plainly because it would have cost a week: **an MCP tool returning does not end the turn.** The model receives a successful tool result and simply carries on - another edit, another bash call. `ask_human` cannot stop anything by itself.

So the daemon is the enforcer, in this exact order:

1. `ask_human` durable-appends the checkpoint intent (question, checkpoint id, fence epoch) and **fsyncs** it.
2. The supervisor **freezes the containment boundary before any successful tool response reaches the model.** `ask_human` never returns success - the attempt dies with the call in flight. A tool result that comes back is a tool result the model will act on.
3. It confirms the boundary is empty and the output FDs are at EOF.
4. It snapshots into the manifest and fsyncs: `HEAD`, base SHA, and a full working-state hash covering **staged, unstaged and untracked** files. Plain `git diff` misses untracked, which is exactly where a half-written new file hides.
5. Only then does it durable-append `parked`.

### The guardian: fail closed when the daemon dies

If the daemon dies before it kills the CLI, a journaled checkpoint stops nothing - the agent is still running and will keep writing. So each attempt runs under a **fail-closed guardian**: a containment boundary plus a heartbeat, which freezes and kills the attempt when the daemon stops heartbeating.

A POSIX process group is **not** sufficient containment - a child can `setsid` and escape. On Linux (our only supported platform for now) the boundary is a **cgroup v2 scope** via `systemd-run --scope`, which no descendant can leave. Narrowing platform support is a deliberate trade: portability is worth less than a containment guarantee that actually holds.

### The honest guarantee

"Exactly one continuation" is not achievable. A crash after launching `--resume` but before durably recording that attempt is unavoidable. What we actually promise, and test:

- **exactly one accepted question and one accepted answer**
- **never two overlapping live attempts**
- **at-least-once, idempotent recovery** - never exactly-once model execution

Claiming exactly-once here would be a lie that the first crash exposes.

### Resume must restore the working directory. Measured.

`--resume` restores the conversation, **not the process's working directory.** We tested it: a session started in `dirA` and resumed from `dirB` reported its cwd as `dirB` and read `dirB`'s file - while its conversation memory still described `dirA`.

That is a silent-corruption trap. A run resumed from the wrong place will operate on the wrong tree while confidently believing it is in its worktree. Therefore every resume launches with the **recorded worktree cwd**, the recorded launch config, and a first instruction to **reconcile against disk before writing**. Disk is the authority; the agent's recollection is not.

### Answers declare their effect

An answer can invalidate work already on disk, and that must not be left to agent judgement. `ask_human` answers carry a declared effect:

- `continue_within_approved_plan`
- `requires_plan_amendment` - quiesce, bump the fence epoch, route back to the plan gate
- `abort`

The latter two invalidate the execution fence so no verification or PR action can use results produced before the answer.

### Not everything is safe to checkpoint

Checkpointing is *worse* than blocking when a run holds state that cannot be reconstructed: an open database transaction, a git index or rebase lock, an external reservation, a local server whose state is expensive to rebuild. **"Safe to checkpoint" is a precondition**; when it does not hold, the question is deferred until the unsafe section completes.

The only retained blocking path is Claude Code's own `--permission-prompt-tool` for sub-minute permission decisions. It is bounded and the CLI owns it.

---

## Components

```
pros/
  packages/cli/          `pros` - run, plan, implement, reconcile, mine, serve, doctor
  packages/daemon/       orchestrator: runs, leases, worktrees, spawn, resume
  packages/adapters/     claude.ts, codex.ts, events.ts  (spawn + tolerant parse)
  packages/mcp/          pros-mcp server: submit_plan, ask_human, report_progress
  packages/miner/        history ingest, correction mining, intent clustering
  packages/review/       session graph, diff risk ranking, "new to you"
  app/                   Next.js dashboard
  db/schema.sql
  prompts/               per-phase instruction files
  agents/                finder + implementer base classes and children
  skills/                plan-debate, finding-session, implementation-session, review
```

---

## Durability model

The earlier version of this said "rebuild the DB from `raw_events`", which was circular - `raw_events` lived *in* the DB. Fixed:

**The run journal lives on disk, outside SQLite.** Each run gets a durable directory holding an append-only journal (`journal.ndjson`), the raw transport logs verbatim per launch attempt, and the manifest. SQLite is a **rebuildable index over that journal**, nothing more.

Git and `gh` genuinely cannot reconstruct: questions and answer ordering, approved plan versions and amendment history, execution attempts and fence epochs, launch config and MCP policy, raw event order, malformed lines, or token accounting. The journal can.

```
~/.pros/runs/<run_id>/
  manifest.json          worktree path, branch, base SHA, diff hash, fence epoch
  journal.ndjson         append-only: every state transition, question, answer, lease
  attempts/<attempt_id>/raw.log      verbatim bytes as emitted, per launch
```

```sql
runs(id, repo, trigger_kind, trigger_ref, state, phase, resume_phase,
     approved_plan_version_id, worktree_id, fence_epoch, cli_versions_json, …)

execution_attempts(id, run_id, phase, provider, cwd, launch_config_hash,
                   fence_epoch, started_at, ended_at, exit_reason)
checkpoints(id, run_id, attempt_id, kind, base_sha, diff_hash, created_at)

raw_events(id, run_id, attempt_id, seq, ts, provider, cli_version,
           raw_text, parse_status,           -- raw TEXT, not json: malformed lines survive
           UNIQUE(run_id, attempt_id, seq))
events(id, run_id, raw_event_id, kind, role, tool_name, payload_json, is_unknown)

agent_sessions(id, run_id, attempt_id, provider, session_id, phase, cwd,
               launch_config_hash, created_at, ended_at)   -- one run has many
worktrees(id, run_id, path, branch, state, fence_epoch)
leases(id, kind, holder, fence_epoch, acquired_at, expires_at)

plans(id, run_id, version, markdown, structured_json, state, UNIQUE(run_id, version))
objections(id, plan_id, round, author, severity, claim, suggested_change, resolution)
questions(id, run_id, idempotency_key, prompt, options_json, answer, answer_effect,
          state, created_at, answered_at, UNIQUE(run_id, idempotency_key))
findings(id, run_id, kind, title, evidence_json)
prs(id, run_id, url, state)
verdicts(id, run_id, kind, worktree_sha, plan_version_id, fence_epoch, result_json)

-- learning loop
session_cards(session_id, task, task_group, outcome, keywords_json,
              preferences_json, knowledge_json, failures_json)
corrections(id, session_id, quote, position, category, generalized_rule)
loops(id, name, scope, spec_yaml, skill_md, state, evidence_json)
preferences(id, rule, evidence_json, scope, state)
```

### Fencing, not just leases

A lease alone is insufficient: after expiry two recovery workers can both believe they own a worktree. Every state transition, MCP call, verification result and PR operation carries the current **fence epoch**, and stale-epoch operations are rejected. The epoch increments on amendment, on recovery, and on lease takeover.

`agent_sessions.last_seq` was also wrong as a resume cursor - it is a *parser* cursor, not a *side-effect* cursor. It cannot tell you whether a question was committed or an answer delivered. Side effects have their own durable state in `checkpoints` and `questions`.

### Verdicts are bound to what they judged

Every verification or review verdict records `(worktree_sha, plan_version_id, fence_epoch)`. Otherwise a correct verdict from before an amendment can approve a tree that has since changed.

### Write capability is a sequencing guarantee, not a flag

"The approved plan id is the write capability" was aspirational - an agent with Bash can write regardless of what a database row says. The real guarantee is ordering: **quiesce the process group and confirm exit, then revoke the fence.** Nothing in the DB can stop a process that is still running.

Same honesty applies to `gh`. An agent inheriting your credentials has merge rights no matter what the prompt says - and a wrapper script is not enough either, since `gh` can be reached by another path or the GitHub API called directly. The only real mechanism is a **scoped token without merge permission**, injected into the attempt's environment in place of your own credentials. "Assert no merge permission" is a test; the scoped token is the mechanism.

### Journal writing rules

Since SQLite is now an index rather than the authority, the journal needs its own discipline: **one serialized writer per run**, length-prefixed records with checksums so a torn tail is detectable, fsync on the record then on the directory, and atomic temp-write-plus-rename for the manifest. Index rebuild replays the journal and stops at the first bad checksum, reporting the truncation rather than silently accepting a short history.

### Safe-to-checkpoint must be enforceable

Declaring a section unsafe cannot be left to the agent's good intentions. Unsafe sections are bracketed by an explicit critical-section protocol recorded in the journal, with defined recovery for the two cases that actually happen: a held git index or rebase lock, and a half-finished git operation. A checkpoint requested inside one is durably deferred, not dropped.

**Unknown events are stored and surfaced.** `events.is_unknown` drives a visible banner, so a run that silently dropped a "verification failed" event cannot look healthy.

---

## Run state machine

```
queued
  └─ finding ──────────────► finding_done ─┐
                                            ├─► planning ─► debating ─► plan_ready
     (bug: extra context-gathering pass) ───┘                              │
                                                                           ▼
                                                          ┌──── awaiting_approval ◄─┐
                                                          │   (CHECKPOINT, no proc) │
                                                          ▼                          │
                                                      approved                       │
                                                          │              amendment_requested
                                                          ▼                          │
                                                    implementing ─────────────────────┘
                                                          │
                                                          ▼
                                                      verifying   (background session)
                                                          │
                                                          ▼
                                                      reviewing   (Codex adversarial + ultrareview)
                                                          │
                                                          ▼
                                                       pr_open
                                                          │
                                                  awaiting_review  (CHECKPOINT)
                                                          │
                                                    done │ abandoned

  any state ──► awaiting_answer (CHECKPOINT) ──► back to the same state
  any state ──► failed
```

**Checkpoint states** - `awaiting_approval`, `awaiting_answer`, `awaiting_review` - are defined by owning no live process group and holding a durable resume token. Everything else is transient and may be killed and resumed.

### Checkpoint sub-states

"Park, then go back to the same state" is not implementable, because the process that was in that state no longer exists. The real path is:

```
running ─► checkpoint_requested ─► quiescing ─► parked
parked  ─► answered ─► claimed ─► resuming ─► consumed ─► running(resume_phase)
```

Each step is a durable journal entry, so a crash at any point retries safely rather than double-delivering. `resume_phase`, `checkpoint_id`, `execution_attempt` and `fence_epoch` are all persisted - `phase` and `state` are separate columns for exactly this reason.

### Edge states that are easy to forget

| State | Occurs when |
|---|---|
| `interrupted` | daemon or process died - distinct from an agent-reported `failed` |
| `resume_failed` / `session_unavailable` | the CLI's local session store no longer has the id |
| `recovery_session_started` | resume impossible, so a fresh session is launched with the manifest and diff rather than a blind retry |
| `answer_rejected_stale` | a human answers a run that already failed, was cancelled, or was superseded |
| `answer_late` | a second concurrent answer - first conditional update wins, the rest are audit-only |
| `amending` | quiesces implementation **and** verification, bumps the epoch, marks all in-flight verdicts stale |

`verifying → amendment_requested` must not let an old verdict reach `reviewing` or `pr_open`. Codex dying gets the same treatment as Claude dying: if its thread cannot resume, start a recovery session from the manifest.

### Session store is local, mutable state

Both CLIs persist sessions on disk locally (Codex under its sessions directory). A machine change, config-dir change or retention sweep makes `--resume` unavailable. That is why `recovery_session_started` exists rather than being an error path.

---

## Phase → model routing

Cost control is routing, plus a lease. Not scope reduction.

| Phase | Driver | Model | Notes |
|---|---|---|---|
| finding | Claude | top tier orchestrates | subagents on Haiku for search, Sonnet for synthesis |
| planning | Claude | top tier | judgment work |
| critique | Codex | high effort | genuinely independent first opinion (see below) |
| **implementation** | Claude | **Sonnet subagents** | explicit requirement; `scoped-fixer` children |
| verification | Claude | Sonnet, background session | returns a verdict, not a stack trace |
| review | Codex + `claude ultrareview` | - | ultrareview runs in the cloud, zero local context |

**Admission control:** unattended runs must acquire a global lease and declare a per-run token ceiling. Interactive runs are never blocked but do consume against the same visible budget. The `rate_limit_event` emitted on every Claude run feeds the gauge.

---

## Keeping work out of the main context

The rule: **verification never runs in the session that wrote the code.** Tests, lint, type-checks, review and diagram generation run in dispatched background sessions or subagents, and only a verdict returns - pass/fail plus minimal failing evidence. A 400-line stack trace is read by a cheap session that returns three lines.

Surfaces, all verified present in `claude` 2.1.232:
- `claude agents --json [--all]` - live session registry (`pid`, `cwd`, `kind`, `sessionId`, `status`), no TTY needed. This is how the dashboard shows what is running and attributes a stuck run to a real process.
- Background dispatch inherits `--model`, `--effort`, `--permission-mode`, `--agent`, `--mcp-config`, `--add-dir`, so a child can be cheaper and more locked-down than its parent.
- `claude ultrareview [target] --json` - cloud multi-agent review.

---

## Plan debate

**Critical invariant, borrowed from the neuroarxiv skill's isolation rule: Claude and Codex must form independent first opinions before either sees the other's.** If Codex is handed Claude's plan as its only input, it critiques wording. It must read the repo and the finding itself.

```
finding ──► Claude drafts plan A          ──┐
       └──► Codex reads repo + finding    ──┴──► exchange ──► round 1 objections
                                                    │
                                        Claude revises or defends (structured)
                                                    │
                                        Codex re-attacks only unresolved items
                                                    │
                                     converged or round cap (default 2)
```

Both sides are schema-constrained - verified working in M0 on both CLIs:

```json
{"objections":[{"severity":"blocker|major|minor","claim":"…","suggested_change":"…"}]}
```

Claude via `--json-schema`, Codex via `--output-schema <file>`. No prose parsing anywhere.

A **pre-flight gate** prevents debating trivia: diffs below a size threshold, or plans with no blocker-class risk surface (no migration, auth, concurrency or API-compat change), skip straight to a single critique pass.

**Measured falsifier**, per Codex's fair challenge: we record per plan the objection count, how many *materially changed* the plan, and the debate's token cost. Pre-committed threshold - if across 10 real plans fewer than 20% produce a material change, the debate collapses to one critique pass. We measure rather than assume, and we do not pre-emptively cut it.

---

## Human gates

Two, and only two.

**Gate 1 - plan approval.** Captured by a `PostToolUse` hook matched on the `ExitPlanMode` tool (the mechanism ref.tools uses), which POSTs the plan to the local daemon. The dashboard renders the plan as a document with the unresolved objections beside it. A sidebar chat accepts "include X" / "change Y", which fires a cheap single-shot rewrite of the plan document, shows a diff, and you accept. Not a new session.

**Gate 2 - PR review.** See below.

**Questions**, at any point: the agent calls `ask_human(prompt, options, idempotency_key)`. It returns immediately, the turn ends, the run parks in `awaiting_answer`. The dashboard's Questions tab shows it. Answering resumes the session with the answer injected. The `idempotency_key` is UNIQUE in SQL, so a replayed tool call after a crash cannot create a second question.

Notification out: **ntfy over Tailscale** - one curl, no OAuth, reaches your phone without exposing anything publicly.

---

## Review and teach

**The primary artifact is the session graph, and it is recorded fact, not inference.**

We proved this works on real data. A deterministic extractor over a 26-minute session produced, with zero LLM involvement: the user's prompts, tool counts (Bash 18, Read 2, Agent 1), files written, the subagent spawned (`finder | Map claw model resolution chain`), the skill invoked (`humanizer`), and the bash verbs (`gh`, `git`). A 7-hour session yielded 185 Bash calls, 8 subagents, 16 files written across three worktrees. Codex conceded this objection outright: it is an event-history visualization, not an inferred code graph.

So the review page renders:

1. **Session graph** - what was explored, decided, changed, verified. Derived from `events`. Labelled as observed activity, never as unrecorded intent.
2. **Intent + risk badge** - one paragraph on *why*. Red when the diff touches auth, payments, migrations or concurrency.
3. **Risk-ranked hunks**, not file-ordered. Lockfiles, generated files and pure reformatting collapsed by default.
4. **Focus checklist** - untested branches, changed error handling, new external calls, concurrency changes.
5. **"New to you"** - the feature only we can build. We have 4.7 GB of your history, so any library, pattern or API in this diff that appears nowhere in your prior sessions gets explained with its trade-off. A computed fact, not the model guessing what you don't know.
6. **Code diagrams** - on demand only, explicitly labelled **static approximations**. Sequence diagram for behaviour change; module-boundary before/after for structural change. The root-cause DAG is an experiment, not a milestone commitment.

---

## Learning loop

Order matters: corrections are the highest-value signal, so they ship first.

- **Stage A - deterministic, zero tokens.** Per session: opening prompt, cwd, whether `pr-link` fired, whether a plan artifact exists, and every correction phrase with its exact quote and position. Late corrections - after the agent believed it was done - rank highest.
- **Stage B - LLM, batched.** Codex's session-card schema: `task / task_group / outcome / keywords`, `preference signals` (quoted correction → generalized rule), `reusable knowledge`, `failures (symptom → cause → fix)`.
- **Stage C - intent clustering, never tool sequences.** A candidate loop requires ≥3 instances, ≥2 sessions with a `pr-link` or plan artifact, **and** a checkable structural template in the opening prompts (URL slot, ticket-ID slot, verb, target repo).
- **Stage D - human gate, always.** Diffable proposals, nothing auto-installs. `/promote-this-session` writes a skill from one exemplar and skips A-C.
- **Stage E - continuous correction-mining → preferences,** scoped by cwd so facts don't leak between the six mothership checkouts.

**Falsifier:** a promoted loop is validated only if, across the next 5 recurrences of its intent, output is accepted without correction - beating the ~26% baseline correction rate.

---

## Agents and skills

Rule: **agent when the job needs isolation** (own context window, tool restrictions, parallelism). **Skill when it is a procedure the current context should follow.**

| Base | Child | Evidence |
|---|---|---|
| `finder` (read-only) | `investigator` | ~410 uses |
| | `verifier` | ~110 |
| | `ground-truth-checker` | ~130 |
| | `pr-auditor` | ~30 |
| `implementer` (writes, in a worktree) | `scoped-fixer` | ~120, dominant pattern |

`implementer.md` is currently **0 bytes** - today every implementation runs through `general-purpose` with hand-written guardrails. Filling it is a real, immediate win.

**Review is a skill, not an agent** - the data already agrees, since `review`/`code-review` skills run alongside the `code-reviewer`/`security-reviewer` agents doing the same job. Review is nearly always followed by "now fix it", so keeping it in context beats a subagent round-trip.

Skills we write, using the neuroarxiv structural template (trigger + explicit anti-triggers, pre-flight abort checklist, numbered phases, a critical-invariant callout, anti-patterns, a cost section, an output-shape spec): `finding-session`, `plan-debate`, `implementation-session`, `review`.

---

## CLI integration

Pin, tolerate, replay - the same thing vibe-kanban ships, which is the right size for one person.

- **Pin exact versions** (`claude` 2.1.232, `codex-cli` 0.147.0) and record `--version` alongside every run's raw log. Anthropic closed the request to document the `stream-json` schema as *not planned*, and Codex's app-server README disclaims cross-version stability - neither stream carries a version field, so pinning is the contract.
- **Tolerant parsing.** Read only the handful of fields we act on. Unknown event types are stored and skipped, never fatal - but they are surfaced in the UI.
- **Replay fixtures.** 3-5 recorded real transcripts per CLI, replayed through the parser before any version bump. The fixture diff is the changelog.

Observed shapes, from M0:

| | Claude | Codex |
|---|---|---|
| invoke | `claude -p --output-format stream-json --verbose` | `codex exec --json` |
| events | `system/init`, `assistant`, `user`, `result`, `rate_limit_event` | `thread.started`, `turn.started`, `item.completed`, `turn.completed` |
| resume | `--resume <session_id>` | `codex exec --json --sandbox … resume <thread_id>` |
| gotcha | - | **global flags must precede `resume`**, else exit 2 |
| second schema | - | rollout files use nested `{timestamp,type,payload}` |

---

## Worktrees

- **The orchestrator allocates** worktree, branch and lease atomically *before* the agent starts, and passes the path in. Instructions are not an allocator; this is what removes the crash-between-create-and-register race.
- **The agent owns the contents**, not the lifecycle state.
- **Many concurrent worktrees per repo** - matching what you already do by hand (`wt-bugs`, `wt-mention`, `wt-seclabel` in one real session).
- A **run manifest** is written into each worktree, so a run is recoverable from the filesystem alone.
- **`pros reconcile`** scans the workspace directory against the registry and offers recovery for orphaned worktrees, branches, sessions and PRs. Ported from vibe-kanban's `cleanup_orphan_workspaces()`. Automated cleanup never runs before reconcile is clean.
- **Resume is idempotent**, keyed by run id, guarded by a durable lease rather than a PID check - PIDs get reused after sleep.

---

## Milestones

Each ends with something runnable, and each has an acceptance test that names the failure it prevents.

**M0 - Spike. DONE.** Both CLIs verified: streaming, resumable, subscription-authed with no API key present, and both honour strict output schemas. Details in `01-m0-results.md`.

**M1 - The checkpoint barrier. The product's foundation, and the first commit.**

Not a spike - the real supervisor. It carries the foundational slices that everything else assumes: **attempt identity, the durable journal, manifests, fence epochs, and minimal worktree identity.** Those cannot live in a later milestone, because a "parked" run in an ambiguous workspace is not parked.

Scope: guardian + containment boundary, durable journal, manifest snapshot, fenced resume with restored cwd, `pros-mcp` with `ask_human`, and a CLI `pros answer`. No SQLite, no UI, no plans, no debate.

*Kill-tests, against the real CLIs plus a deterministic forking-child fixture. The fixture matters: an LLM prompt is not a reliable way to test containment, because a compliant model proves nothing about an escaping one.*

| # | Failure injected |
|---|---|
| 1 | Tool call issued, agent then tries another write → barrier stops it |
| 2 | Daemon dies **before** quiescence, after intent is durable → guardian kills the group; recovery never launches a competing attempt |
| 3 | Child ignores `SIGTERM`, forks, calls `setsid`, or retains stdout → parking completes only when the containment boundary is empty |
| 4 | Crash during each durable write: torn journal record, manifest temp-write/rename, directory fsync, raw-log append |
| 5 | Crash after spawning resume but before its attempt record is durable → recovery detects, kills or adopts; never a second resume |
| 6 | Late MCP call, event, or verdict from an old attempt after a fence change → rejected, cannot advance state |
| 7 | Snapshot with staged **and** unstaged **and** untracked changes |
| 8 | Recorded cwd moved, symlinked, replaced, or no longer the recorded worktree at resume time |
| 9 | Checkpoint requested during an unsafe section → durably deferred, then parks once or is rejected on interruption; never silently lost |
| 10 | Disk full / IO error while journaling or snapshotting → fails closed; no answer accepted, no resume permitted |
| 11 | Two daemon recovery or lease-takeover attempts race → one guardian survives |

*Acceptance:* one accepted question, one accepted answer, never two overlapping live attempts, idempotent recovery. And a resume launched from the wrong directory is **impossible**, because cwd comes from the manifest.

**M2 - `pros plan`.** Manual trigger → finding session → Claude plan → independent Codex critique → debate → plan markdown + structured objections. Adapters, raw capture, tolerant parser. Includes the **minimal worktree allocator and fence epochs** - a parked run in an ambiguous workspace is not actually parked. No UI.
*Acceptance:* on a seeded bug, a finding citing the right `file:line`. Parser snapshot-tested against fixtures from both CLIs. The "Codex materially changed the plan" assertion runs against a **stubbed critique fixture**, not a live model - real-model quality is measured separately, because a test that depends on a stochastic model is a flaky test.

**M3 - Gate 1.** `submit_plan`, the `ExitPlanMode` hook, dashboard with Runs / Plan / Questions, ntfy push.
*Acceptance:* a run that must ask a question parks with no live process group, appears in Questions, resumes on answer. Kill the daemon mid-wait; it still resumes. Plan editing changes the document without restarting the run. The hook payload is **fixture-tested** and is never the only source of plan truth.

**M4 - Gate 2.** Multi-worktree ergonomics, Sonnet `scoped-fixer` implementation, verification in a background session, Codex adversarial review + `ultrareview`, draft PR via `gh`, `pros reconcile`.
*Acceptance:* end-to-end on a seeded bug → draft PR exists, main untouched, worktree reaped. Kill mid-implementation; `pros reconcile` recovers with no orphans. Merge is blocked by a **command policy wrapper**, and the test proves the wrapper rejects the verb - not that the prompt asked nicely.

**M5 - Session graph and review.** Session graph, risk-ranked hunks, focus checklist.
*Acceptance:* every node traces to a real `raw_events` row. A generated code diagram citing a symbol absent from the AST fails the build.

**M6 - Learning loop.** Correction mining first, then session cards, then intent clustering, then the Loops page. **"New to you" ships here, not in M5** - it needs the history index that this milestone builds.
*Acceptance:* the miner independently rediscovers the mothership triage cluster and ≥20 of the ~290 known corrections. Known-present data makes this a real regression test.

**M7 - Ambient.** Linear, Slack, scheduled sweep, Granola triggers; skillrank weekly proposals.

Cost analytics is **deferred**, per D16.

### The first commit

A standalone `checkpoint-barrier` supervisor. No SQLite, no UI, no plans, no worktree allocator, no debate.

It launches one real CLI attempt inside a cgroup scope, receives `ask_human`, durable-appends the intent with fsync, freezes and kills the whole attempt, waits for boundary emptiness and pipe EOF, then atomically writes the manifest.

Its test instructs the real CLI to ask a question and then write a sentinel file, and asserts: **the sentinel does not exist**, every descendant is dead, the journal ends in `parked`, and a resumed invocation starts in the manifest's cwd. The same commit ships the deterministic forking-child fixture, so containment is proven against a process that actively tries to escape - not just against a well-behaved model.

If that commit works, the riskiest thing in the system is settled. If it does not, nothing above it is worth building.

### Two traps to design around on day one

**Filesystem-plus-SQLite is not atomic.** `git worktree add`, branch creation, manifest write and a SQLite transaction cannot be one operation. Build allocation as a **recoverable saga**: write the intent record first, then act, then confirm - and let reconcile finish or roll back anything caught in between.

**Replay and dedup.** Partial lines at process death, late output after termination, and resume attempts all produce duplicates. Launch-attempt identity plus raw-line persistence must be designed in from the start, not retrofitted - which is why `raw_events` is keyed `UNIQUE(run_id, attempt_id, seq)` and stores raw text rather than parsed JSON.
