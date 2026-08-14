# M0 - measured results

Everything here was run live on this machine against the real CLIs. Nothing is inferred.

Installed: `claude` 2.1.232 · `codex-cli` 0.147.0 · `gh` 2.97.0 · node v24.18.1 · sqlite3 · jq.

---

## Subscription auth, not API billing

`env` contains **no** `ANTHROPIC_*` or `OPENAI_*` keys, and both CLIs ran anyway.

The decisive evidence is that Claude reports its quota. The **first line** of every headless run:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed_warning","rateLimitType":"seven_day",
  "utilization":0.84,"isUsingOverage":false,
  "surpassedThreshold":0.75,"resetsAt":1786964400}}
```

`seven_day` is the subscription's weekly pool - the same one interactive Claude Code draws on. This is the measurement that closed the prime/OMP question: those tools bill per token from "extra usage" by their own documentation, while the official CLI spends the subscription.

It is also free telemetry. The orchestrator reads it per run for admission control on unattended work.

## Event streams

**Claude** - `claude -p --output-format stream-json --verbose` produced 18 events for a one-tool task:

```
rate_limit_event → system/init → system/thinking_tokens ×N
→ assistant(thinking) → assistant(tool_use) → user(tool_result)
→ assistant(thinking) → assistant(text) → result
```

The `result` event carries `session_id`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`, and `modelUsage` per model.

**Codex** - `codex exec --json` is a flat schema:

```json
{"type":"thread.started","thread_id":"01a000c4-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"DONE"}}
{"type":"turn.completed","usage":{"input_tokens":14128,"cached_input_tokens":11008,
  "cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

**Two Codex schemas exist.** Live stdout is flat as above; the persisted rollout files in `~/.codex/sessions/` use nested `{timestamp, type, payload}`. The adapter needs both - flat for live runs, nested for history mining.

## Resume

Both resume and recall prior context.

- Claude: `--resume <session_id>` ✓
- Codex: `codex exec --json --sandbox read-only resume <thread_id>` ✓
- **Gotcha:** Codex global flags must precede `resume`. `codex exec resume <id> --sandbox …` exits 2 with *"unexpected argument '--sandbox' found"*.

### Resume does NOT restore the working directory

The most important thing M0 found, because it is a silent-corruption trap.

Test: start a session in `dirA` (containing `marker.txt` = `MARKER_A`), then resume it from `dirB` (`marker.txt` = `MARKER_B`) and ask it to report `pwd` and read the file.

Result: it reported `dirB` and read `MARKER_B` - while its conversation memory still described working in `dirA`.

So a run resumed from the wrong directory operates on the wrong tree while believing it is in its worktree. **Every resume must set cwd explicitly from the run manifest**, and the first resumed instruction must reconcile against disk before writing.

## Structured output - the debate loop's dependency

Both CLIs honoured a strict schema:

```json
{"objections":[{"severity":"blocker|major|minor","claim":"…","suggested_change":"…"}]}
```

Claude via `--json-schema '<inline>'`, Codex via `--output-schema <file>`. Given a deliberately bad plan - *"fix the flaky login test by adding a 5 second sleep"* - both returned valid conforming JSON and both independently rated it blocker/major with root-cause reasoning.

The debate loop can be typed end to end. No prose parsing anywhere.

## Session control surfaces

`claude agents --json [--all]` returns a live registry with no TTY required:

```json
[{"pid":89533,"cwd":"…","kind":"interactive","startedAt":1786718106623,
  "sessionId":"1520d175-…","name":"prosharness-44","status":"busy"}]
```

Useful for observability - but **not authoritative process ownership.** The daemon's own spawn record and process group are authoritative; this is a cross-check.

`claude ultrareview [target] --json` runs a cloud-hosted multi-agent review of a branch or PR and returns a findings payload, costing zero local context.

## Session activity is derivable deterministically

A plain extractor over real session JSONL, with **zero LLM involvement**, reconstructs what a session did.

A 26-minute session yielded: the user's 5 prompts, tool counts (Bash 18, Read 2, Agent 1, AskUserQuestion 1, Skill 1, Write 1), files written, the one subagent spawned (`finder | Map claw model resolution chain`), the skill invoked (`humanizer`), and bash verbs (`cd`, `gh`, `git`).

A 7-hour session yielded 185 Bash calls, 8 subagents, and 16 files written across three separate worktrees (`wt-bugs`, `wt-mention`, `wt-seclabel`) - incidentally confirming that many concurrent worktrees per repo is existing practice, not a new requirement.

This is recorded fact, not inference, which is why the session graph is the primary teaching artifact.
