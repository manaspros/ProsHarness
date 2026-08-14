# Research findings

Everything here is evidence-backed. `[confirmed]` = read in source or official docs. `[measured]` = we ran it. `[inference]` = reasoned, not proven.

---

## 1. OMP is oh-my-pi, and it does not solve the subscription problem

**Question:** does OMP let us drive Claude on the subscription rather than per-token billing? If yes, fork prime and use that method.

**Answer: no.** [confirmed]

"OMP" resolves to **`can1357/oh-my-pi`** (docs at omp.sh), a fork of Mario Zechner's `pi-mono` - the *same upstream* that prime-agent's coding agent is built on. Prime and OMP are siblings, not alternatives.

And OMP uses the identical mechanism prime does. From its own source (`packages/ai/src/providers/anthropic.ts`, `utils/anthropic-auth.ts`):

- It takes `ANTHROPIC_OAUTH_TOKEN` - a `sk-ant-oat…` grant, i.e. the Claude Code subscription's OAuth token - and uses it as a raw bearer credential against `https://api.anthropic.com/v1/messages` directly.
- `buildAnthropicHeaders()` sets `x-app: cli` plus a beta profile built by `buildCoworkBetas()`, whose own code comment reads: *"Cowork's beta profile is part of the OAuth fingerprint."*

That comment is the whole story. The header set is deliberately matched so Anthropic's backend accepts a subscription OAuth token from a non-Anthropic client. It is the same fingerprint-spoofing route as prime, just better documented.

Also ruled out by search: there is no "Open Model Protocol", no repo named `omp` in this space, Oh My Posh is unrelated, `open-mem/omp` is a memory layer, `HKUDS/OpenHarness` is unrelated.

**Consequence:** the "fork prime/OMP and use their subscription method" path is closed, because their method is the thing we are avoiding. The only mechanism that draws on the real subscription pool is the official CLI - which we measured directly (`rate_limit_event`, `rateLimitType: "seven_day"`).

### Could prime still be forked, using CLI subprocesses instead?

Technically yes. [confirmed] `StreamFn` in `packages/agent/src/types.ts` is an **injectable parameter** of `agentLoop()`, defaulting to `streamSimple` only when not supplied, and `config.model` is inert metadata that is never validated against a credentialed provider. So prime can run with no HTTP provider at all if you supply a CLI-subprocess `StreamFn`.

But the cost is bad: ~800-1,500 LOC of new code, `packages/ai` (the largest package) left as dead weight, and a semantic mismatch - `claude -p` runs its own internal tool loop, so prime's IPython-kernel tool surface would sit unused unless you additionally bridge prime's tools back in as an MCP server. You would be fighting the codebase's centre of gravity.

**Verdict: do not fork prime or OMP.**

---

## 2. vibe-kanban: port the parsers, do not fork

Two independent assessments disagreed on the headline, so here is what they actually agreed on - the facts.

**What it really does** [confirmed, read at commit `4deb7ec`]:

- It does **not** do one-shot `claude -p` per turn. It spawns a long-lived subprocess and speaks Claude Code's **control protocol** over stdin/stdout (`initialize`, `set_permission_mode`, `send_user_message`), injecting Claude Code **hooks JSON** at init. Flags: `-p --permission-prompt-tool=stdio --permission-mode=... --verbose --output-format=stream-json --input-format=stream-json --include-partial-messages --replay-user-messages`.
- Codex is driven through **`codex app-server`** (a JSON-RPC daemon), not `codex exec`. Resume is `thread_fork(session_id)`.
- Both streams collapse into one cross-agent enum, `NormalizedEntryType` (`crates/executors/src/logs/mod.rs:73`): `UserMessage`, `AssistantMessage`, `ToolUse{tool_name, action_type, status}`, `Thinking`, `ErrorMessage`, `TokenUsageInfo`. **This taxonomy is the single most reusable idea in the repo.**
- Worktrees: genuinely many-concurrent. A workspace is a directory holding one `git worktree` per attached repo, keyed by branch name. Nothing is singleton.
- **Orphan recovery** (`workspace_manager.rs:538-612`): `cleanup_orphan_workspaces()` scans the workspace base directory on startup and deletes any subdirectory not referenced by a DB `workspace` row. Simple, proven, and exactly the reconcile mechanism we need.

**What we must not copy** [confirmed]: `ExecutorApprovalService::wait_tool_approval` blocks - the child agent process stays resident with its turn suspended while an async task awaits a DB row change. That is the architecture we specifically need to avoid for human-scale waits (see §3).

**Where it fights us:** its unit of work is a kanban task with an implicit sequence of `execution_processes` rows. Ours is an explicit run state machine with a plan-debate phase and two human gates - and plan approval does not exist in its model at all (an `ExitPlanMode` plan is just another chat entry approved via the generic hook banner). Its executor crate is not decoupled from `crates/db`, `MsgStore` and `json_patch`, so "use only the executor crate" means dragging half the Rust workspace along.

**Verdict: PORT, don't fork.** Take three things: the argv and control-protocol shapes, the `NormalizedEntryType` taxonomy (copy the shape, not the Rust type), and `cleanup_orphan_workspaces`. That is a one-to-two day study, not a 217K-LOC inheritance.

---

## 3. How ref.tools actually works, and the answer to the question protocol

**Mechanism** [confirmed from docs.ref.tools]:

- Ref Plans exposes an MCP server over Streamable HTTP (`https://api.plan.ref.tools/mcp`). Everything is a **tool**: create/update plan, a Comments tool with `request_review`, and an `AwaitReview` tool the agent calls to pause for a human.
- For agents Ref does not control (Claude Code CLI, Codex), it does something crude and instructive: it **appends literal curl commands to the task prompt** and relies on the agent's normal bash capability to call home. Not MCP-native - just prompt engineering.
- The one real injection point is a **Claude Code hook on plan-mode exit**: it POSTs the plan to Ref's API and opens it in a browser. [inference] Since Claude Code has no dedicated `ExitPlanMode` hook event, this is almost certainly a `PostToolUse` hook matched on the `ExitPlanMode` tool name - a known community pattern.

**That hook is directly stealable and is our plan gate.**

**What MCP actually supports** [confirmed from the spec]:

| Primitive | Control | Right for us? |
|---|---|---|
| Tools | model-controlled | **Yes** - the model must autonomously decide to submit a plan or ask a question |
| Prompts | user-controlled (slash-command shaped) | No - the model cannot trigger them |
| Resources | application-controlled context | No |
| `instructions` on initialize | system-prompt-like hint | Yes - Claude Code CLI surfaces it. [unverified] for Codex; test empirically |
| Elicitation (`elicitation/create`) | server requests structured human input mid-call | Supported in Claude Code CLI; Codex adding it through 2026 (PRs #17043, #35725) |

**The decisive constraint:** the MCP lifecycle spec says clients **SHOULD enforce a maximum timeout regardless of progress notifications**. So a tool call blocked for twenty minutes waiting for a human is liable to be killed by the client's own ceiling.

**How real products handle it** [confirmed]: local tools block because the process is cheap to keep alive (OpenHands halts in `WAITING_FOR_CONFIRMATION`; Claude Code's own `--permission-prompt-tool` blocks). Hosted products checkpoint and restart - Cursor Background Agents and Copilot's coding agent end the run, notify, and treat a follow-up comment as a **new run**.

**Decision: checkpoint, do not block.** `submit_plan` and `ask_human` return immediately with an id and the turn ends. The orchestrator restarts the session with the human's decision injected as the next message. This survives laptop sleep, auth expiry and orchestrator restarts, dodges the MCP timeout ceiling, and matches what every product doing human-scale waits actually does. True blocking is reserved for sub-minute permission prompts, where Claude Code's own mechanism already works.

**Notification out:** ntfy over Tailscale is the simplest reliable push to a phone - no OAuth, no public exposure, one curl.

---

## 4. The learning loop: tool-sequence mining is dead, corrections are the gold

We tested the adversarial critique empirically rather than arguing with it. **The critique was right, and being right about it is what makes the real design findable.**

**Tool n-grams do not discriminate.** [measured] Across every project cluster - mothership (166 sessions), Project (9), AgentRegistry (8), mothership-beta (2) - the top tool trigram is always `(Bash, Bash, Bash)`. Bash first-tokens are dominated by `cd` (4,334). A production-incident session and a homework session are identical at the skeleton level. `subagent_type` is similarly useless: 875 of 1,366 spawns are just `general-purpose`.

**Intent text does discriminate.** [measured over `history.jsonl`, 10,520 typed lines] Real, nameable, recurring jobs:

| Recurring job | Occurrences |
|---|---|
| Ticket / error triage on mothership | 593 |
| "use subagents" (a style habit, not a task) | 1,111 |
| PR review | 329 |
| Glean/Slack context-gathering before acting | 259 |
| Deploy to beta then verify | 254 |
| Root-cause analysis | 151 |
| kubectl / EKS live investigation | ~200 |
| Production incident handling | 61 |
| Merge-conflict resolution | 58 |
| Skill authoring / installation | 34 |
| Plan-execution handoff | 9 explicit + 22 completed plan files |

There is a genuine operational loop here: *mothership misbehaves → pull ticket/PR/Slack/Glean/kubectl context → RCA → fix or deploy to beta → verify → ship.*

**Outcome signal is sparse but one field is solid.** [measured] `type:"pr-link"` events fire in 90 of 362 main sessions (25%) - structured, harness-emitted, reliable. `gh pr create` / `git commit` greps are unreliable (8 and 17 hits) because most of that happens via MCP or inside subagents. `stop_hook_summary` records which hooks ran, not success. The 22 `.claude/plans/*.md` files are a decent proxy for "this was real work."

**Positive sentiment barely exists - do not build on it.** [measured] Only 26 hits for "perfect"/"thanks"/"nailed it" across 10,520 lines, several false positives.

**Corrections are the richest field in the entire dataset.** [measured] ~290 lines: "revert" (58), "still broken" (82), "no/wrong" (74), "i told you / i said" (32). And they are specific and quotable:

> "no you actually did it wrong way... you had to raise PR on your branch and then ci will run"
> "Revert the changes that you have done. And list down all the things that you have tried and that didn't work."

A correction is unambiguous ground truth. The user is stating exactly what was wrong. Repetition only implies value; a correction *asserts* it.

**Codex already ships this pipeline, and it works.** [confirmed] `memories_1.sqlite` runs two job kinds: `memory_stage1` (per-thread, 25 done) and `memory_consolidate_global`. Stage 1 emits a schema'd record per thread - `task / task_group / task_outcome / keywords`, then `Preference signals` (quoted correction → generalized rule), `Reusable knowledge`, `Failures and how to do differently` (symptom → cause → fix). Stage 2 merges into `MEMORY.md` scoped by `applies_to: cwd=…`. Output quality is high and directly actionable:

> "For reviews, read the full diff first; provide severity-ranked `File:line` findings, a concrete scenario and code-level fix, explicit non-findings, and approve/keep-open/close disposition."

**Copy:** the two-stage architecture, the four-part schema, cwd-scoping (mothership has ≥6 checkout paths - this prevents cross-repo leakage), and quoting the user's real words rather than paraphrasing.
**Improve:** `usage_count` is tracked but never used to prune or weight. `selected_for_phase2` passes 20 of 21 - the selection gate is nearly a no-op, which is the same "everything looks valuable" failure the critique warns about.

### The design

**Primary: correction-mining for preferences, intent-clustering for workflows, human nomination as the fast path.**

- **Stage A - deterministic, zero tokens.** Per session, extract: opening prompt, project/cwd, whether `pr-link` fired, whether a plan artifact exists, and every correction phrase with its exact quote and position. Late corrections - after the agent believed it was done - rank highest.
- **Stage B - LLM, batched.** Produce Codex's session-card schema per session. Not tool sequences.
- **Stage C - clustering over intent, never over tool sequences.** A cluster becomes a candidate loop only with ≥3 instances, spanning ≥2 sessions that have a `pr-link` or plan artifact, **and** a checkable structural template in the opening prompts (a URL slot, a ticket-ID slot, a verb, a target repo). This catches mothership triage and starves the one-offs.
- **Stage D - human gate, always.** Proposals are diffable. Nothing auto-installs. `/promote-this-session` skips A-C entirely and writes a skill from one exemplar - with only 90 PR-linked sessions, waiting for three auto-discovered instances is often too slow.
- **Stage E - continuous correction-mining, feeding preferences rather than workflows.** This is the highest-leverage half. It fixes 290 observed friction points directly.

**Falsifier:** a promoted loop counts as validated only if, across the next 5 recurrences of its intent, the user accepts its output without correcting it - i.e. its correction rate beats the ~26% baseline. For preferences: previously-seen correction categories must stop recurring.

---

## 5. Skills landscape

[confirmed via skillrank live search] Nothing exists for plan-debate, dual-model consensus, or session-handoff-with-approval-gates. Searches for "plan approval", "codex claude debate", "session handoff" returned zero. We write those three skills ourselves.

Worth reading for mechanics: `obra/using-git-worktrees`, `rohitg00/parallel-worktrees`, `rohitg00/batch-orchestration`, `rohitg00/agent-teams` (shared task list + mailbox between Claude Code sessions - closest prior art for finding→implementation handoff).

The **neuroarxiv skill** is an arXiv literature-grounding skill, unrelated to our function. But its *structure* is the best template we found for the skills we must write:

- frontmatter `description` that front-loads when to trigger **and explicit anti-triggers**
- a pre-flight abort checklist before expensive work - directly applicable to the plan-debate skill, which must not debate a one-line diff
- named numbered phases with a **"critical invariant"** callout for the silent failure mode; theirs is isolation-must-not-leak, which maps exactly to our requirement that Claude and Codex form genuinely independent first opinions before cross-critique
- an anti-patterns section and a **cost section** stating how many agent calls the skill spends
- an output-shape spec, which our plan-debate skill needs so the browser gate renders structured plan data rather than prose
