# Zero-token rework -- reusing what you already have instead of provisioning more

Written after M1-M7 and the post-M7 cleanup pass, in response to a direct
question: "why can't we use the person's already existing creds like already
configured MCP or already configured github" -- followed by "that should work
without need token also." This document records what changed, why, and what
is now genuinely optional versus load-bearing.

**Bottom line: nothing needs to be provisioned to run this system end to
end, for a single operator with an interactive Claude Code environment and a
logged-in `gh` CLI.** Every credential that was previously on the
must-configure list is now either eliminated (reused from something you
already authenticated once, for a different reason) or demoted to opt-in
hardening. `pnpm -r typecheck` stays clean across all 18 typechecked
packages; `pnpm -r test` grew from 296 tests to 321 (313 after the trigger
and notify rework, +8 more after the GitHub rework), all passing except the
same 1-2 self-skipping real-CLI acceptance tests this project has always had
(see `docs/11-project-status.md`'s "Known gaps").

---

## The shape of the idea, once

Every credential this rework removed was removed the same way: **find the
thing the user already authenticated for a different, legitimate reason,
and drive it through the same mechanism this project already trusts for
spending the subscription** -- a short-lived `claude -p` subprocess, or an
already-running deterministic process the user already logged into by hand.
Nothing here invents a new trust relationship; each change reuses one that
already existed before this rework started:

| Credential removed from the must-configure list | Reused instead |
|---|---|
| `PROS_LINEAR_API_KEY` (+ `PROS_LINEAR_API_URL`) | The user's OAuth-connected `claude.ai Linear` MCP server, already showing `✔ Connected` in `claude mcp list` |
| `PROS_SLACK_BOT_TOKEN` (+ `PROS_SLACK_CHANNEL`) | The user's OAuth-connected `claude.ai Slack` MCP server |
| `PROS_GRANOLA_API_KEY` | The user's OAuth-connected `claude.ai Granola` MCP server |
| `PROS_NTFY_URL` | The same Slack MCP connection, sending a DM instead of a push |
| `PROS_GH_PR_TOKEN` | The operator's own `gh auth login` session, already sitting on disk |

Each of these MCP servers was confirmed connected on the development machine
via `claude mcp list` at the time this rework was built (`Linear`, `Slack`,
and `Granola` all showed `✔ Connected`). `gh auth status` on that same
machine reported **not** logged in -- which is exactly the case the new
`checkGhAuthenticated()` preflight (below) is built to fail on loudly rather
than silently.

---

## 1. Trigger sources: MCP-first, API-key fallback

**Files:** `packages/triggers/src/sources/{linear,slack,granola}.ts`,
`packages/triggers/src/mcp-fetch.ts` (new), `packages/triggers/src/types.ts`,
`packages/cli/src/schedule.ts`.

Each source's `fetchSignals()` now tries, in order:

1. `fixturePath` (unchanged) -- tests and dry-runs always take this path,
   never touching MCP or the network.
2. **The MCP path** (new, default in production): a short-lived,
   schema-constrained `claude -p` call (via `ModelSession`, the same
   dependency-injection seam `packages/plan`'s finding/debate/critique
   pipeline already uses so tests never spawn a real CLI) instructing the
   model to use its already-connected Linear/Slack/Granola MCP tools,
   **read-only**, and return JSON shaped exactly like the existing fixture
   type. Bounded by `mcpTimeoutMs` (default 20000ms, overridable via the new
   `PROS_MCP_TIMEOUT_MS` env var) so a hung/disconnected MCP server can never
   wedge a trigger sweep.
3. **The API-key path** (unchanged code, now explicitly a fallback): only
   reached if the MCP path fails or times out *and* the source's API-key
   options are explicitly set (`PROS_LINEAR_API_URL`+`PROS_LINEAR_API_KEY`,
   etc.) -- documented as the fallback for headless reliability, per the
   real, observed failure mode below.
4. If MCP fails and no API-key fallback is configured, the source now
   **throws** a specific, descriptive error instead of silently returning
   `[]`. This is a deliberate behavior change from M7 (where "not
   configured" and "silently degraded" were the same `[]`): MCP-unavailable
   is not the same thing as "the operator never set this up," and the two
   must be distinguishable. The throw is caught by the existing
   `runTriggerCycle` per-source isolation (`packages/triggers/src/runner.ts`)
   -- recorded in `sourceFailures`, surfaced by `pros schedule status` and
   the dashboard's `/schedule` page, and it does **not** affect any sibling
   source in the same sweep cycle. No new plumbing was needed for this;
   `runTriggerCycle`'s existing per-source try/catch already does exactly
   what "graceful, observable degradation, never wedge the daemon" requires
   -- the only change was to stop swallowing the MCP-unavailable case into a
   silent `[]`.

### The headless caveat, stated plainly

The interactively-authenticated `claude.ai` MCP servers this rework depends
on are known, from direct experience building this project, to disconnect
mid-session. An unattended `pros schedule start` daemon firing a trigger
sweep at 3am may find Linear/Slack/Granola's MCP servers absent -- there is
no guarantee an OAuth session initiated interactively stays alive for an
unattended process running on a cron-like interval. This is why the
API-key path was kept, not deleted: for a deployment where trigger sources
must fire reliably unattended over long periods, provisioning
`PROS_LINEAR_API_KEY`/`PROS_SLACK_BOT_TOKEN`/`PROS_GRANOLA_API_KEY` remains
the documented, more-reliable-for-headless-use option. The MCP-first default
optimizes for "works immediately, with what you already have, for a human
who's around to notice and re-auth an MCP server if it drops" -- not for
"survives an unattended host indefinitely with zero human present," which
is a different, harder property the scoped API-key path buys you if you
need it.

---

## 2. Notifications: Slack via MCP, ntfy kept as an alternative

**Files:** `packages/notify/src/{slack-mcp,transport}.ts` (new),
`packages/notify/src/wire-barrier.ts`, and the three call sites that thread
notification options through (`packages/plan/src/pipeline.ts`,
`packages/implement/src/pipeline.ts`, `packages/triggers/src/admit.ts`).

`PROS_NTFY_URL` is no longer required. `@pros/notify` is now
transport-pluggable:

- If `PROS_NTFY_URL` is set, notifications go out via ntfy, **exactly as
  before** -- `sendNtfy` was not touched, deleted, or weakened; every
  existing ntfy test still passes unchanged.
- If it is not set, notifications default to a **Slack DM sent via the
  connected Slack MCP server**, driven by a short-lived `claude -p` call
  (`sendSlackMcp`, same `ModelSession` injection seam as the trigger
  sources) with the same never-throws, bounded-timeout contract `sendNtfy`
  already had (`{ok:false, error}` on any failure -- MCP unavailable,
  timeout, malformed response -- never a thrown exception, never a hang).

### Destination safety

By default, with no configuration, the Slack-MCP transport DMs **the
authenticated user themselves** -- there is no channel name to configure for
this, since "send yourself a message" requires no target at all. If the
operator wants notifications routed to a named channel instead, they can set
`PROS_SLACK_NOTIFY_TARGET`. There is no default that posts to a shared or
public channel; a named target is always something the operator chose.

This transport was built and tested entirely against injected fake
`ModelSession`s -- **no test in this rework ever sent a message to a real
Slack workspace**, per the hard constraint given for this work. The same
"a failed/unconfigured notification must never wedge a run or drop a
question" invariant this project has held since M3 was re-proven for the
new default transport, not just assumed to still hold.

---

## 3. GitHub: zero-token by default, scoped token as opt-in hardening

**Files:** `packages/implement/src/pr.ts`, `packages/implement/src/pipeline.ts`,
`packages/cli/src/reconcile.ts`, `packages/adapters/src/spawn-common.ts`.

This is the one credential change where "just remove it" was not an option
-- the whole point of `PROS_GH_PR_TOKEN` was a real safety property: **the
agent must be unable to merge; only the human merges.** Removing the token
without replacing what it did would have removed the property, not just the
friction. So the mechanism moved, not the guarantee.

### The old mechanism: a credential GitHub itself refuses to let merge

Unchanged, and still fully supported: `RealGhClient` + `loadCredentialFromEnv`
still read `PROS_GH_PR_TOKEN`, a fine-grained PAT scoped to
`pull_requests:write` + `contents:read` + `metadata:read`. GitHub's own
merge-PR endpoint checks the `contents` permission -- the same one that
gates `git push` -- which is separate from `pull_requests`, so this token
can open/manage a draft PR but a merge attempt with it gets a **403 from
GitHub's own servers**, not a client-side refusal this code added. Nothing
about this path changed; every M4 test proving it (`packages/implement/test/
pr.test.ts`'s CORE REQUIREMENT/CONTRAST pair, `e2e-m4.test.ts`) still passes,
unweakened.

### The new default: the boundary moves from the credential to the process

When `PROS_GH_PR_TOKEN` is unset, `runGate2Pipeline` (and `pros reconcile`'s
PR-ops recovery step) now default to:

- **The model/agent subprocess gets no GitHub credential at all.**
  `packages/adapters/src/spawn-common.ts`'s `spawnCli()` -- the one shared
  place both `spawnClaude` and `spawnCodex` route every subprocess spawn
  through -- now unconditionally strips `GH_TOKEN`/`GITHUB_TOKEN` from the
  child's environment and repoints `GH_CONFIG_DIR` at a scratch path that is
  never created, so even if the model's own Bash tool tries to invoke `gh`
  directly, there is no ambient session on disk for it to find. This
  applies to **every** model subprocess this project spawns -- finding,
  debate, critique, implement, verify, review -- not just Gate 2's
  implementer session. No session type should ever be able to act as an
  authenticated GitHub identity, and now none of them structurally can,
  regardless of what the operator's own shell happens to have set.
- **The orchestrator -- deterministic TypeScript, never a model --** opens
  the draft PR itself, via the new `AmbientGhClient`, which shells out to
  `gh` inheriting the orchestrator process's own environment (i.e. the
  operator's real `gh auth login` session, the one they already have from
  using `gh` for anything else). Before attempting this, `checkGhAuthenticated()`
  runs `gh auth status` as a preflight and throws a clear, actionable error
  ("gh is not authenticated -- run `gh auth login`, or set
  `PROS_GH_PR_TOKEN` to use a scoped token instead") rather than letting a
  confusing `gh pr create` failure surface deep in the pipeline.
- **`AmbientGhClient.mergePr` throws, unconditionally, for any input, with
  no scope check to satisfy and no way to make it succeed.** This is
  deliberately different from `RealGhClient`'s `mergePr` (which exists so
  the *scoped-token* boundary is provable by test, and which a correctly-
  scoped credential really can invoke if it had `contents:write`).
  `AmbientGhClient` has no real GitHub-enforced boundary to lean on --
  ambient `gh auth` genuinely *can* merge -- so the code-level mitigation is
  that there is simply no reachable code path to the merge command at all in
  this client. It's a smaller guarantee than the scoped token's, and the
  next section says so honestly.

### The honest tradeoff, stated once, not softened

**The zero-token default trusts the orchestrator process. The scoped token
does not.** If `PROS_GH_PR_TOKEN` is never set, "the agent can't merge"
holds only as long as nothing ever calls `AmbientGhClient.mergePr` or
otherwise drives `gh pr merge` from inside the orchestrator's own code path
-- and the orchestrator is deterministic TypeScript that the operator (or,
notably, an implementation run *of this very project, on itself*) could in
principle modify. If `PROS_GH_PR_TOKEN` **is** set, the guarantee is
enforced by GitHub's own servers regardless of what the orchestrator's code
says -- a compromised or careless orchestrator still gets a 403 on a merge
attempt with that token. This is a real, asymmetric difference, not a
rounding error: the zero-token path is convenient and correct for normal
operation; the scoped-token path is strictly stronger and is the right
choice the moment "an agent could plausibly modify this orchestrator's own
source" stops being hypothetical -- which is exactly the case when
ProsHarness is used to work on ProsHarness itself. No cheap mitigation
closes that gap entirely (a self-modifying orchestrator can rewrite its own
checks by definition); the one mitigation actually worth taking --
`AmbientGhClient.mergePr`'s unconditional, scope-check-free throw, so there
isn't even a boolean sitting around to flip -- was taken, and is documented
as exactly what it is: smaller than GitHub's own enforcement, not a
replacement for it.

### `pros reconcile`

Applies the same precedence for its PR-ops recovery step: ambient `gh` when
no token is set (after the same preflight), scoped token when one is set. If
even the ambient `gh` session isn't authenticated, that sub-check is
reported as skipped with a clear reason -- worktree and lease recovery still
complete regardless, exactly as this invariant already worked before this
rework (an optional credential must never hold the rest of `reconcile`
hostage).

---

## The resulting setup list

**Nothing is required to run this system end to end**, given: an
interactive Claude Code environment with Linear/Slack/Granola MCP servers
connected (optional -- trigger sources and notifications degrade
observably, not silently, if any of these are absent or disconnect), and a
`gh auth login` session for draft PRs (required only at the point Gate 2
tries to open one; `checkGhAuthenticated()` fails clearly and immediately if
missing, rather than partway through a confusing `gh` invocation).

**Optional hardening**, listed separately from anything required to start:

| Env var | What it buys you over the zero-token default |
|---|---|
| `PROS_GH_PR_TOKEN` (+ `PROS_GH_PR_SCOPES`) | GitHub-server-enforced merge boundary, safe even against a compromised orchestrator -- see "the honest tradeoff" above. |
| `PROS_LINEAR_API_URL` + `PROS_LINEAR_API_KEY` | Headless reliability for the Linear trigger source if the interactive Linear MCP connection is expected to be absent for long unattended stretches. |
| `PROS_SLACK_BOT_TOKEN` + `PROS_SLACK_CHANNEL` | Same, for the Slack trigger source. |
| `PROS_GRANOLA_API_KEY` | Same, for the Granola trigger source (Granola's real API shape remains unconfirmed -- unchanged known gap from M7). |
| `PROS_NTFY_URL` | An alternative push-notification transport (e.g. if you'd rather not use Slack for this, or already have an ntfy topic set up). |
| `PROS_SLACK_NOTIFY_TARGET` | Route notifications to a named Slack channel instead of the default self-DM. |
| `PROS_MCP_TIMEOUT_MS` | Tune how long a trigger source waits on an MCP call before falling back/failing (default 20000ms). |

Everything else this project already required before this rework
(`PROS_RUNS_DIR`, `PROS_WORKTREES_DIR`, `PROS_INDEX_DB`, `PROS_LEASE_DIR`,
etc. -- directory locations, not credentials) is unchanged; see
`docs/11-project-status.md`'s configuration table.

---

## Test results

`pnpm -r typecheck`: clean across all 18 typechecked packages (unchanged
count from before this rework -- no new packages were added).

`pnpm -r test`, full run after all three changes: **321 tests, 320 passing,
1 skipped, 0 failing.** The one skip is the same class of expected variance
this project has always had (`@pros/mcp`'s real-CLI acceptance test
self-skipping under load -- see `docs/11-project-status.md`'s "Known gaps").
Package-by-package: adapters 7 (+2 new), agents 7, lease 12, miner 15,
skillrank 14, barrier 20, review 16, index 5, worktree 6, notify 18 (+9 new),
mcp 12 pass + 1 skip, graph 5, plan 16, dashboard 63, implement 37 (+4 new),
triggers 28 (+8 new), schedule 21, cli 18 (+2 new).

All new tests run entirely offline, against injected fakes/stubs:

- Trigger-source MCP tests use a fake `ModelSession` returning canned
  fixture-shaped JSON -- never a real `claude` subprocess or a real
  Linear/Slack/Granola account.
- Notification tests use a fake `ModelSession`/transport -- never a real
  Slack workspace or ntfy endpoint.
- The GitHub-credential-stripping test spawns a cheap `node -e` child process
  through the real `spawnCli()` and inspects its reported environment,
  proving `GH_TOKEN`/`GITHUB_TOKEN` are stripped and `GH_CONFIG_DIR` is
  repointed even when the *parent* test process has them set -- no real
  `claude`/`codex`/`gh` binary involved.
- `AmbientGhClient`'s merge refusal and `checkGhAuthenticated`'s two branches
  are unit-tested directly; the full ambient-path pipeline is exercised
  end-to-end via a from-scratch local stub (mirroring M4's own
  `LocalGhStub` pattern: a real local bare git repo, no scope checks,
  matching `AmbientGhClient`'s real behavior) -- never a real GitHub
  account, and correctly so, since this development machine's own
  `gh auth status` genuinely reports not logged in.

---

## What did not change

- The two human gates (plan approval, PR review) are exactly as before --
  this rework touches how a signal reaches the pipeline and how a
  notification/PR gets created, never who approves or merges.
- `@pros/barrier`'s checkpoint machinery, fence epochs, and the M1 kill-test
  suite: untouched.
- The scoped-token GitHub path, the existing ntfy client, and every
  existing API-key-configured trigger-source path: all still fully present
  and tested, none deleted, all still the right choice for a headless/
  hardened deployment.
- `packages/dashboard` and root-level run scripts: out of scope for this
  rework by explicit instruction (a parallel effort was working on getting
  the app running).
