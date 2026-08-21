# Decision log

Every row is a decision that is now settled. When something here changes, edit the row and note why - do not silently reverse it.

Status key: **settled** (decided, build it) · **open** (research pending) · **deferred** (real, not now).

---

## Round 1 - scoping

| # | Decision | Status |
|---|---|---|
| D1 | Single user (dogfood) first. Multi-tenant is a later storage+auth refactor, not a design constraint now. | settled |
| D2 | Implementation stops at a **draft PR**. Never merges. Merging stays human. | settled |
| D3 | **Git worktree per session**, many concurrent per repo (see D14). | settled |
| D4 | **Claude drives, Codex is the adversary.** Claude does finding, planning, implementation; Codex challenges plans and reviews diffs. | settled |
| D5 | v1 spine = **session orchestrator + plan approval**. Everything else plugs into it. | settled |
| D6 | Dashboard is a **localhost web app**, not a desktop app - because the human gates (approve plan, review PR) happen when you are away from the desk, and a web app behind Tailscale is approvable from a phone. Tauri can wrap the same app later if wanted. | settled |
| D7 | Triggers: manual first, then Linear, Slack, scheduled sweep, Granola. All normalize to one trigger interface. | settled |

---

## Round 2 - responses to the Codex adversarial review

Codex returned a verdict of RETHINK with three blockers. Here is what we accepted, what we rejected, and why. Accepting a critique does not mean cutting the feature; in several cases it means building it properly instead of naively.

### D8 - Quota: rejected as a blocker, accepted as a design input
**Codex said:** at 84% of the weekly Claude pool, an unattended factory industrialises consumption; make v1 a single manual command with a hard budget.

**Ruling:** the quota window resets shortly, so the measurement was a snapshot, not a trend. We do not cut scope for it. But the underlying point - that this system's cost scales with sessions spawned - is real, and the answer is **model routing, not feature removal**:

- Implementation work runs on **Sonnet subagents**, explicitly, not on the top-tier model.
- Exploration and search run on the cheapest tier that clears the bar.
- The top tier is reserved for judgment: planning, adversarial critique, synthesis.
- The `rate_limit_event` on every run stays, used as **admission control** for scheduled/unattended work only. Interactive runs are never blocked by it.

**Rejected:** "one Claude session total, no background work". That deletes the product.

### D9 - Process ownership and crash recovery: accepted
**Codex said:** the hard part is not spawning CLIs, it is process/session lifecycle - orphaned worktrees, duplicate resumes, disagreement between SQLite, git, GitHub and CLI history.

**Ruling: accepted in full.** This is the most valuable thing the review surfaced. Consequences:

- **Git and the CLI session id are the source of truth for recovery**, not our normalized event table. Our DB is a projection and is allowed to be rebuilt from them.
- Every run writes a **durable run manifest** into its worktree, so a run is recoverable from the filesystem alone.
- An explicit **`pros reconcile`** command detects orphaned worktrees, branches, sessions and PRs and offers recovery. Automated cleanup is never allowed to run before reconcile is clean.
- Resume is **idempotent**: a resume is keyed by run id, and a second resume of a live run is refused rather than forked.

**Rejected:** "narrow the system to synchronous one-shot commands". That is the same as not building it.

### D10 - "Exactly two session types": accepted and replaced with something better
**Codex said:** two session types is a brittle taxonomy; real work has ten shapes; forbidding implementation from re-planning causes silent deviation or deadlock.

**Ruling: accepted.** Replaced by a two-level model:

- `finder` and `implementer` are **base classes**, not session types. They define capability and permission posture: `finder` is read-only and investigative; `implementer` may write, in a worktree.
- Concrete agent types are **subclasses** of those, created for jobs actually done often (derived from real usage data, not invented).
- Work that is a procedure rather than a role is a **skill**, not an agent. Follow-up review is a skill.
- The rule: **an agent when the job needs its own context window and tool restrictions; a skill when it is instructions the current context should follow.**

Also accepted: implementation may discover that the plan is wrong. There is a bounded **`plan amendment required`** transition back to the plan gate. Silent deviation is the failure mode we are avoiding, and Codex is right that forbidding replanning causes it.

### D11 - Plan debate: kept, with a measurement attached
**Codex said:** cross-model debate is agreement theatre; a single strong model plus a deterministic checklist would match it at lower cost.

**Ruling: kept.** Two models arguing to a plan is the core of what we are building, and the mechanism already exists and works - the Codex plugin's adversarial review runs automatically as the critique pass. One side produces findings, both argue, they converge on a plan.

**Accepted from the critique:** the falsifier is fair and we will run it. We record, per plan: how many objections were raised, how many materially changed the plan, and what the debate cost. If material change rate is near zero across ten real plans, the debate collapses to a single critique pass. We measure rather than assume - but we do not pre-emptively cut it.

### D12 - CLI output drift: accepted, proportionately
**Codex said:** building a durable data model on an unstable CLI contract is unsafe; we already observed two Codex schemas.

**Ruling: accepted, at single-person scale.** The minimum that removes the risk:

- **Store raw events immutably**, exactly as emitted, before any normalization. Normalized rows are a derived projection and can be recomputed.
- **Tolerant parsing**: unknown event types and unknown fields are recorded and ignored, never fatal.
- **Golden fixtures** captured from the installed CLI versions, so a version bump that changes the stream fails a test instead of corrupting data.

We do not build version gates or a compatibility matrix. That is the enterprise answer to a one-person problem.

### D13 - Human questions: open pending research
**Codex said:** parking a live agent subprocess on a long-poll is fragile - laptop sleep, auth expiry, or a restart breaks it, and resuming may replay the tool call.

**Ruling: the concern is real, the design is open.** We are researching how ref.tools does exactly this (MCP prompt injection plus a dashboard), and what MCP actually supports (elicitation, progress, cancellation). The choice is between blocking a live process and checkpoint-and-resume. Questions themselves are **not** cut - the user is explicit that questions will always arise mid-session and must surface somewhere other than a terminal.

### D14 - Worktree lifecycle: settled, and not the way Codex proposed
**Codex said:** support one active implementation per repo in v1, and have the orchestrator own worktree creation.

**Ruling: rejected the "one per repo" limit.** Many concurrent worktrees per repo is a requirement, not a nice-to-have. The lifecycle works like this:

- The **session instructions tell the agent to always start in a fresh workspace**, so worktree creation is part of the session contract rather than an external step racing it.
- At session end, a **hook instructs the agent to clean up its workspace once work is pushed to a PR.** We instruct rather than delete: the agent knows whether its work landed; an external reaper does not.
- Nothing is force-deleted by us. Orphans are surfaced by `pros reconcile` (D9) and cleaned only with confirmation.

The competing-authority problem Codex identified is real and is resolved by naming one owner: **the agent owns its workspace, the orchestrator owns the registry of workspaces.**

### D15 - Diagrams: scope corrected, and the objection no longer applies
**Codex said:** a tree-sitter call graph is not "known correct" under dynamic dispatch, DI, reflection or cross-service calls; the root-cause DAG is speculative; cut auto-diagrams.

**Ruling: the objection was aimed at the wrong target, because the primary diagram is not a code diagram.**

The thing we most need to draw is **what a session did** - what it explored, what it decided, what it changed, what it verified. The ground truth for that is the session's own event stream, which we already capture completely. No AST inference, no call-graph correctness claim, nothing to hallucinate. It is a rendering of recorded fact.

That becomes the primary diagram, and it is the answer to "models say jargon and I do not learn": you see the shape of the work instead of reading a transcript.

**Accepted:** code-structure diagrams (call path, module boundary) are secondary, generated on demand, and labelled as **static approximations** - never presented as correctness-grounded. The root-cause DAG is demoted to an experiment, not a milestone commitment.

### D16 - Scope: keep triggers and questions, drop cost
**Codex said:** cut ambient triggers, the questions tab, diagrams, skill recommendations, mining and the spend dashboard.

**Ruling: partially rejected.** Triggers and questions stay - they are load-bearing. A factory with no trigger is a CLI, and a session that cannot ask a question stalls.

**Accepted:** cost analytics is **deferred**. It was always the side quest. The contradiction Codex found is noted and resolved: subscription **utilization** (from `rate_limit_event`) is the admission-control signal; **token counts** are the operational metric; we do not display dollar totals for subscription usage, because those numbers are not what is being spent.

---

## Round 3 - research answers and the Codex round-2 rulings

All six open questions are answered. Evidence is in `02-research-findings.md`. Codex reviewed the round-2 rulings and conceded D9 and D15 outright, rejected D8 and D14, and partially conceded the rest. Here is what changed.

### D17 - Base: build our own, port from vibe-kanban. Do not fork prime, OMP, or vibe-kanban
**Answers Q1, Q2, Q3.**

- **OMP is `oh-my-pi`**, a sibling fork of the same `pi` upstream prime uses - and it takes the *same* route: subscription OAuth token replayed against `api.anthropic.com` with a matched header fingerprint. Its own code comment says the beta profile "is part of the OAuth fingerprint". **The legitimate-subscription path the user hoped for does not exist there.** Closed.
- **Prime *can* run on CLI subprocesses** - `StreamFn` is injectable and `config.model` is never validated - but it costs 800-1,500 LOC, strands its largest package as dead weight, and leaves prime's tool surface unused because `claude -p` runs its own tool loop. Not worth it.
- **vibe-kanban: port, don't fork.** Take the argv and control-protocol shapes, the `NormalizedEntryType` taxonomy, and `cleanup_orphan_workspaces()`. Leave the 217K LOC and the kanban data model, which has no plan-approval concept and blocks a live subprocess for approvals - the exact thing we must not do.

### D18 - Human gate protocol: checkpoint, never block
**Answers Q4. Resolves D13, which Codex called the highest remaining risk.**

MCP's own lifecycle spec says clients SHOULD enforce a maximum timeout regardless of progress notifications - so a tool call parked for twenty minutes on a human is liable to be killed by the client. Hosted products all checkpoint (Cursor, Copilot, Devin); only local tools block, and only for sub-minute permission prompts.

So: `submit_plan` and `ask_human` are MCP **tools** that return immediately with an id, and the turn ends. The orchestrator restarts the session with the human's decision injected as the next message. This survives laptop sleep, auth expiry and orchestrator restart, and eliminates Codex's entire "parked process" failure class.

The plan gate is captured by a `PostToolUse` hook matched on `ExitPlanMode` - the same mechanism ref.tools uses. Notification out is ntfy over Tailscale.

**Blocking is retained only for sub-minute permission prompts, via Claude Code's own `--permission-prompt-tool`.**

### D19 - Learning loop: corrections first, intent second, tool sequences never
**Answers Q5. The adversarial critique was empirically correct and that is what made the real design findable.**

Measured: the top tool trigram is `(Bash, Bash, Bash)` in *every* project cluster. Tool-sequence mining is dead and is abandoned.

What is alive: **corrections.** ~290 correction lines ("revert" 58, "still broken" 82, "no/wrong" 74, "i told you" 32) against only 26 positive-sentiment hits in 10,520 lines. A correction is ground truth - the user states exactly what was wrong - where repetition only implies value.

Design: deterministic extraction → Codex-style session cards → intent clustering gated on `pr-link` outcome (90/362 sessions) plus a structural prompt template → mandatory human gate → `/promote-this-session` as the fast path. Correction-mining runs continuously and feeds **preferences**, not workflows. Codex's own two-stage memory pipeline is the prior art we copy, including cwd-scoping.

### D20 - Agent taxonomy, derived from usage rather than invented
**Answers Q6.** Note: `implementer.md` is currently **0 bytes** - every "implement X" today runs through `general-purpose` with hand-written guardrails.

| Base class | Concrete child | Evidence |
|---|---|---|
| `finder` (read-only, own context) | `investigator` - repo/trace search | ~410 uses |
| | `verifier` - confirm a claim or fix, cite file:line | ~110 |
| | `ground-truth-checker` - external API/gh/Langfuse cross-check | ~130 |
| | `pr-auditor` - retrospective PR/regression harvest | ~30 |
| `implementer` (writes, in a worktree) | `scoped-fixer` - worktree-isolated, file-allowlisted single fix | ~120, the dominant pattern |

**Review becomes a skill, not an agent** - and the data already agrees: `review` and `code-review` exist as skills *and* as `code-reviewer`/`security-reviewer` agents, running side by side. The rule: **agent when the job needs isolation** (own context, tool restrictions, parallelism); **skill when it is a procedure the current context should follow.** Review is nearly always followed by "now fix it", so keeping it in-context is cheaper than a subagent round-trip.

### D21 - Quota: accepted, Codex was right
Codex rejected D8 and it is correct. Model routing lowers average burn but is not capacity control - several scheduled runs can each pass admission against the same stale `rate_limit_event` and collectively exhaust the pool.

Added: a **global concurrency lease** and **per-run token ceilings**, on top of the Sonnet routing. Unattended runs acquire a lease before starting; interactive runs are still never blocked but now *consume* against the same visible budget rather than being invisible to it.

### D22 - Worktree lifecycle: revised, Codex was right about the race
Codex rejected D14's ownership split and the argument holds: session instructions are not an atomic allocator. An agent can create a worktree and die before registering it (reconcile then reports a live worktree as an orphan), or delete it after pushing but before completion is recorded (destroying its own manifest during recovery).

**Revised, and it still gives you everything you asked for:**
- **The orchestrator allocates** a uniquely named worktree, branch, and durable lease *before* the agent starts, and passes the path in. Allocation is atomic; instructions are not.
- **The agent owns the contents**, not the lifecycle state.
- Many concurrent worktrees per repo remain a hard requirement - matching what you already do by hand (`wt-bugs`, `wt-mention`, `wt-seclabel` in a single real session).
- Cleanup stays hook-driven and instruction-shaped at the agent end, but the authoritative reaper is a `pros reconcile` that scans the workspace directory against the registry - vibe-kanban's proven `cleanup_orphan_workspaces()` pattern.

### D23 - Plan amendment fencing
Codex partially conceded D10 and asked which plan version authorizes writes. Answer: **the approved plan id is a write capability.** On `plan amendment required`, write capability is revoked before the human sees the diff, so an in-flight tool call cannot land changes against a plan the human never approved.

### D24 - CLI drift: pin, tolerate, replay
Confirmed: Anthropic **closed** the request to document the `stream-json` schema as "not planned", and Codex's app-server README explicitly disclaims cross-version stability. Neither stream carries a version field.

vibe-kanban's shipped answer is the right size for one person, so we copy it: **pin exact CLI versions** and capture `--version` alongside each run's raw log; **tolerant parsing** (read only the handful of fields we act on, never fail on unknown event types); **3-5 recorded transcripts per CLI as replay fixtures** before any version bump. Skip schema negotiation and contract tooling.

One addition Codex asked for and it is fair: unknown or unprojected events must be **visible in the UI**, so a run that silently lost a "verification failed" event cannot look healthy.

---

## Round 4 - build order, not scope deletion

Codex's final verdict is BUILD REDUCED, with a list of things to cut: dashboard, ntfy, two-model debate, multi-worktree concurrency, automated PR, session graph, diagrams, learning loop, ambient triggers, skillrank.

**Read carefully, that is a sequencing argument, not a scope argument**, and it does not conflict with the decision to keep those features. Its actual claim is that the checkpoint barrier must be *proven* before anything is layered on it - because every one of those features assumes a run can be safely parked and resumed, and none of them work if that assumption is false.

So nothing is deleted. **D25: the checkpoint barrier is M1 and ships alone.** Everything else keeps its place in the roadmap behind it. If the barrier holds, the rest is ordinary work. If it does not, the rest was never going to work anyway.

Two corrections from round 4 worth flagging because they were genuine design bugs:

- **`ask_human` must never return success.** The original design had it return immediately and the turn end - but a returned tool result is a result the model acts on. The attempt now dies with the call in flight.
- **A process group is not containment.** A child can `setsid` and escape. Linux cgroup v2 scope is the boundary, which means Linux-only for now - a trade we accept, because portability is worth less than a guarantee that holds.

And one claim we withdrew as dishonest: **"exactly one continuation" is not achievable.** A crash after launching `--resume` but before recording the attempt is unavoidable. We promise one accepted question, one accepted answer, no overlapping live attempts, and idempotent at-least-once recovery.

---

## Round 5 - a real darwin containment backend, honestly weaker

D25's "Linux-only for now" left the non-negotiable invariant ("a parked run must own no live model process") **unenforced on the machine most contributors actually develop on**. `systemd-run` and cgroup v2 do not exist on darwin, so `Guardian.launch` degraded to a readiness poll that always timed out, and the guardian test suite never terminated. The decision: **build a real macOS backend, not a stub, and be explicit in code and docs that it is a weaker guarantee, not a portable rewrite of the Linux one.**

**D26: `Guardian` is split into a platform-agnostic dispatcher (`guardian.ts`) plus one `GuardianBackend` implementation per platform** (`guardian-linux.ts`, `guardian-darwin.ts`), selected once at module load from `process.platform`, never per call. The interface (`guardian-backend.ts`) is the pre-split `Guardian` class's own existing public surface (`isEmpty`/`freeze`/`thaw`/`killAll`/`cgroupGone`/`teardown`), not a new shape invented for the split. `guardian-linux.ts` is the original cgroup/systemd-scope code, moved essentially unchanged; its tests describe it exactly as before.

**The darwin backend (`DarwinProcessGroupBackend`) has no cgroup v2 to lean on.** It spawns with `detached: true` (which itself calls `setsid(2)` on POSIX, so the launched process starts in its own session outside the daemon's process group), and contains the tree by repeatedly walking `ps -axo pid,ppid,stat` from that root and SIGKILLing every live descendant found, looping to narrow (never close) the window for a fork that lands mid-pass.

**A real bug was caught and fixed while building this, not merely anticipated:** the first implementation re-walked the tree fresh from `rootPid` on every pass. The moment `rootPid` itself died -- typically on the very first pass, since it is usually discovered and killed immediately -- the kernel re-parents any still-live descendant to launchd (ppid 1), and a walk that starts from a now-dead root finds nothing, reporting "boundary empty" while a live, orphaned grandchild kept running. This was reproduced directly in this backend's own test suite (`packages/barrier/test/guardian.test.ts`, kill-test #3 and the race-window test), not just reasoned about. The fix: `known`, a per-boundary `Set<number>` that only ever grows -- every PID ever confirmed to descend from `rootPid` stays tracked for the life of the boundary, regardless of whether its immediate parent later dies. `aliveKnownDescendants` (guardian-darwin.ts) and its duplicate in `watchdog.mjs` (which cannot import the TS module graph -- it is spawned as a raw subprocess by path) both implement this.

A second design considered and rejected: holding `rootPid` alive and killing it last, so anything it forks while still alive keeps showing up as its child in the next snapshot instead of jumping straight to launchd. This is real defense-in-depth against a *finite* fork burst, but measured directly against this backend's continuous-forking adversarial test fixture, it made things strictly worse: an adversary that keeps forking for as long as its root survives never produces a pass with "nothing else alive," so the loop burned its entire 3s budget every time and still killed the root at the very last moment anyway -- all cost, no benefit. Killing everything discovered on every pass, root included, is both faster and no worse: a well-behaved attempt stops forking the instant its root dies (nothing is left to schedule more children), which is exactly what keeps the residual race window bounded to "whatever forked in the last snapshot-to-signal gap" instead of open-ended.

**Honest parity table** (Linux vs. darwin, same containment operation):

| Guarantee | Linux (cgroup v2) | darwin (PID-tree walk) | Parity |
|---|---|---|---|
| Kill whole tree incl. `setsid` escapees | `cgroup.kill`, atomic | walk-and-SIGKILL loop, repeated | **partial** -- racy, bounded not atomic |
| Freeze without killing | `cgroup.freeze` | `SIGSTOP` per discovered PID | **partial** -- a fork after the freeze snapshot is not paused |
| Membership check (`isEmpty`) | read `cgroup.procs` | `known`-set + `ps` reconstruction | **partial** -- racy, PID reuse not ruled out |
| Per-tree CPU/memory cap | cgroup v2 limits | none (`setrlimit` is per-process, not per-tree) | **none** |
| Orphan reaping if the daemon dies | watchdog polls heartbeat | identical mechanism, platform-appropriate walk | **full** |

**Measured, not assumed:** against a fixture that forks a new escaping grandchild every 20ms for as long as its root survives, a single naive snapshot-and-kill pass (root killed immediately, no deferral) left 0-1 stragglers per run; the real `killAll()` loop (same immediate-kill strategy, given its full budget) converged to 0 survivors within 200-350ms across repeated runs. The race window is real but small under realistic fork rates -- see `packages/barrier/test/guardian.test.ts`'s race-window test for the reproducible measurement, gated darwin-only.

**Rejected alternatives:**
- **`sandbox-exec`** -- deprecated by Apple with no replacement API; building on a removed-tomorrow primitive is a worse bet than an honestly-imperfect PID walk.
- **macOS App Sandbox** -- designed for a signed, distributed app opting itself into a sandbox at launch, not for confining an arbitrary already-running CLI subprocess (`claude`, `codex`) after the fact. Wrong model entirely, not just an inconvenient API.
- **A new dependency** (`tree-kill`, `pidtree`, `execa`, etc.) -- all do the same `ps`-based PID-tree walk this backend needs in ~40 lines; none solve the `setsid`-to-launchd re-parenting case any better than tracking a persistent `known` set does here.

**Explicitly out of scope, and a separate decision if it ever becomes real:** a per-tree memory/CPU cap on darwin. `setrlimit` is per-process, not per-tree, and there is no cgroup-equivalent aggregate limit available to an unprivileged process. If this is ever genuinely required, the shape of the fix is a `launchd`-per-attempt redesign (a launchd job can carry resource limits), not a swap inside `GuardianBackend` -- a new decision, not an extension of this one.

## Round 6 - Mermaid for decision-card diagrams: a version bump that is security-relevant, not routine

Phase 5a needed a diagram format for the Gate 1 decision card. Surveyed D2, PlantUML, Graphviz/DOT, nomnoml, Pintora, svgbob, and Excalidraw before choosing. The deciding constraint: **the same diagram source must also render inside a GitHub PR body**, and GitHub natively renders only Mermaid. Every alternative means maintaining two diagram representations (one for the dashboard, one degraded/absent in the PR) -- an ongoing cost, not a one-time one. DOT was eliminated outright for lacking sequence/state diagrams, which this project's Gate 1/Gate 2 cards need.

**D27: pin `mermaid` at exactly `11.16.1` in `packages/dashboard/package.json`, no `^`/`~`.** This is called out explicitly as an exception to this repo's normal "don't upgrade dependencies casually" default, for the opposite reason most bumps get flagged: **mermaid's sanitizer has a live track record of being bypassed.** Checked before pinning (2026-08-21): `11.16.1` (published 2026-08-04, clearing the 7-day release-age cooldown) fixes CVE-2026-71439 (radar-diagram DoS), CVE-2026-71438 (config-API prototype pollution), CVE-2026-71437 (architecture-diagram prototype pollution), CVE-2026-71436 (XY-chart DoS), and CVE-2026-50159 (CSS injection) -- no unpatched CRITICAL was found against `11.16.1` itself. `11.17.0` (published 2026-08-19, 2 days old at review time) is explicitly NOT adopted yet -- it sits inside the cooldown window with no offsetting security justification found. **Re-verify advisory status before bumping past `11.16.1` for any reason other than a newly disclosed CVE that `11.16.1` itself is vulnerable to** -- do not "helpfully" float this to `^11.x` later; a caret range on a package with this CVE history reintroduces exactly the risk pinning was meant to remove.

**Mermaid renders LLM-generated source, which is untrusted input by definition** -- the diagram text comes from a model's plan response (`packages/plan/src/plan.ts`'s `structured.diagram`), never from a human author. `securityLevel: "strict"` is set, but per this round's threat model it is NOT trusted as sufficient on its own -- CVE-2025-54880 and CVE-2025-54881 (both CRITICAL, 2025) were XSS bypasses of mermaid's own sanitizer specifically. Defense in depth: the rendered SVG *output* (not the diagram source) is embedded into an `<iframe sandbox="" srcDoc={...}>` with an EMPTY sandbox attribute -- no `allow-scripts`, no `allow-same-origin`. Even a fully sanitizer-bypassing payload cannot execute at all inside that iframe, regardless of what mermaid produces. A render timeout (5s) and a source-length cap (20,000 chars) bound the DoS class of advisory separately. See `packages/dashboard/components/mermaid/MermaidDiagramClient.tsx` for the implementation and `packages/dashboard/test/mermaid-sandbox.test.ts` for the regression test.

**Bundle cost accepted knowingly:** mermaid is ~952 KiB gzip / 3.4 MB minified (it bundles d3, dagre/ELK, cytoscape, KaTeX). Loaded via `next/dynamic(() => import("./mermaid/MermaidDiagramClient"), { ssr: false })` from `components/MermaidDiagram.tsx`, so it lands in its own webpack chunk, fetched only by a route that actually renders a diagram -- never in the initial dashboard payload or on routes with no plan diagram.

**Rejected: `@mermaid-js/mermaid-cli` for server-side rendering.** It peer-depends on `puppeteer`, i.e. shipping a full Chromium binary into this dashboard's dependency tree for what is, at Phase 5a's scale, a client-side rendering need. Client-side rendering behind the sandboxed-iframe defense above was judged the better trade for this project's single-operator scale.
