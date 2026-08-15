# M4 implementation log -- Gate 2

Status: **COMPLETE**. `pnpm -r typecheck` and `pnpm -r test` are green across
all 13 workspace packages (12 with a `test` script; `@pros/dashboard` has no
backend logic beyond what's already tested). Every M4 acceptance criterion
in the plan has a real, passing test -- see the table near the end.

Read `docs/README.md`, `docs/00-decisions.md`, and `docs/03-architecture.md`
first if you haven't. This log assumes M1 (checkpoint barrier), M2
(`pros plan`'s adapters/index/worktree/plan pipeline) and M3 (Gate 1: hook,
`submit_plan`, dashboard, ntfy) as given -- read `docs/04`, `docs/05`, `docs/06`
for those.

## What M4 is

Gate 2: the second and last human gate. Once a plan is approved at Gate 1,
`runGate2Pipeline` (in the new `@pros/implement` package) drives:

```
implement (Sonnet scoped-fixer, in the Gate-1-allocated worktree)
  -> verify (a SEPARATE background session -- returns a verdict, not a stack trace)
  -> adversarial review (Codex + a fresh "claude ultrareview" pass, a SKILL not an agent)
  -> draft PR (via gh, using a scoped credential that cannot merge)
  -> park for Gate 2 (human reviews the draft PR and merges it themselves)
```

The system never merges. Merge is blocked by a real GitHub permission
boundary (a credential lacking `contents:write`), not a wrapper script or a
prompt -- see "The merge boundary" below, it is the single most
safety-critical piece of this milestone.

## New/changed packages

| Package | What it is |
|---|---|
| `@pros/lease` (new) | Global concurrency lease (`ConcurrencyLease`, disk-durable, mkdir-locked critical section) and per-run `TokenCeiling`. The cost mechanism per D21: model routing + a concurrency cap + token ceilings, no cost dashboard. |
| `@pros/agents` (new) | Loads `.claude/agents/*.md` and `.claude/skills/**/SKILL.md` (frontmatter + body) so pipeline code can inject the same briefs a human/interactive session would see, rather than hand-duplicating instructions in two places. |
| `.claude/agents/finder.md`, `implementer.md`, `scoped-fixer.md` (new) | The D20 agent taxonomy. `implementer.md` was previously **0 bytes** (per the decision log) -- it is now a real base-class brief (Sonnet-only, worktree-contract, scope discipline, commit discipline, and -- added during integration -- explicit "push your own branch, never a shared/protected one" guidance, since the Gate 2 pipeline depends on the branch already being pushed by the time it runs). `scoped-fixer.md` is the concrete, file-allowlisted child. |
| `.claude/skills/review/SKILL.md` (new) | Adversarial review as a **skill**, not an agent (D20: review is nearly always followed by "now fix it" -- cheaper to keep in-context than a subagent round-trip). Documents the Codex-adversarial + `claude ultrareview` two-pass procedure and the shared `Objection` shape. `@pros/implement`'s `review.ts` loads this file's text into its prompts rather than duplicating the procedure. |
| `@pros/implement` (new) | The Gate 2 pipeline itself: `implement.ts`, `verify.ts`, `review.ts`, `pipeline.ts`, `pr.ts`. |
| `@pros/barrier` (extended) | Added `gateType: "pr_review"`, a `prRef` field, and `Barrier.parkForGate2` -- structurally identical to M3's `parkForGate1`, just for a draft PR instead of a plan. Backward compatible: existing `gateType`s/tests untouched. |
| `@pros/notify` (extended) | `ParkedNotificationInfo`/`wireNtfyNotifications` now handle `gateType: "pr_review"` with a PR-specific title/message. |
| `@pros/cli` (extended) | New `pros reconcile [--stale-after=<ms>]` verb. |

## `@pros/implement`'s modules

- **`implement.ts`** -- `runImplementation`. Loads the `scoped-fixer` brief via `@pros/agents`, builds a prompt (brief + approved plan + explicit file allowlist + "commit before finishing"), runs it via a caller-supplied `ModelSession` (real: `RealClaudeSession`, i.e. a real `claude -p` subprocess). Verifies a real commit landed (`git rev-parse HEAD` before/after), and **post-hoc verifies the file allowlist** against `git diff --name-only` -- a commit touching a file outside the allowlist throws `AllowlistViolationError` before verification/review/PR ever sees it. Accepts an optional `TokenCeiling`.
- **`verify.ts`** -- `runVerification`. **The most safety-critical file in the milestone.** Two hard, code-enforced invariants: (1) never sets `resumeSessionId` -- verification always starts a brand-new session, never resumes the implementer's; the caller is expected to pass a fresh `ModelSession` instance (`runGate2Pipeline` defaults to a second, separate `new RealClaudeSession()`); (2) the fence epoch is checked via `loadRunState`/`StaleFenceError` (from `@pros/barrier`) **before** the model runs (a stale run must not even spend tokens) **and again after** (an amendment/abort landing mid-verification discards the verdict rather than returning it). The return type is `Verdict` (`{outcome, summary, failingChecks}`) and *only* that -- `--json-schema`-constrained, so raw stdout/stack traces never leave the function; full raw logs still go to `rawLogPath` on disk, just never into the return value. An unparseable response throws rather than defaulting to `"pass"`.
- **`review.ts`** -- `runAdversarialReview`. Loads `.claude/skills/review/SKILL.md`, runs a Codex pass and a fresh-session Claude "ultrareview" pass against the real `git diff <baseSha> <headSha>`, both constrained to the same `Objection` shape `@pros/plan`'s Gate 1 critique already uses (`severity: blocker|major|minor`). Gate 2 review is one-shot and non-interactive (unlike Gate 1's debate-to-convergence) -- any `blocker` found is therefore unresolved by construction, and `verdict: "blockers-present"` blocks the PR.
- **`pr.ts`** -- draft-PR-via-`gh`, and the merge boundary (below).
- **`pipeline.ts`** -- `runGate2Pipeline` ties the above together (implement -> early-return-if-no-commit -> verify -> early-return-if-fail -> review -> early-return-if-blockers -> journal a `pr_create_intent` -> `createDraftPr` -> journal `pr_created` -> `barrier.parkForGate2` -> best-effort worktree reap). Also exports `reconcilePrOps`, the PR-ops half of `pros reconcile`.

## The merge boundary (the milestone's hardest requirement)

**What a human must provision**, verbatim from `packages/implement/src/pr.ts`'s
doc comment (the actual source of truth -- read it there too):

> GitHub -> Settings -> Developer settings -> Fine-grained tokens
> - Repository access: ONLY this repository (not "all repositories")
> - Repository permissions:
>     - `Pull requests`: Read and write
>     - `Contents`: **Read-only** (NOT "Read and write")
>     - `Metadata`: Read-only (required minimum for any fine-grained token)
>
> Store it as `PROS_GH_PR_TOKEN` (and optionally `PROS_GH_PR_SCOPES`, a
> comma-separated list, default covers the three above). **Never** reuse
> the operator's own `gh auth login` session or a classic repo-scoped PAT --
> both of those can merge.

Why this holds for real, not just in this repo's tests: GitHub's merge-PR
endpoint (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) checks the
token's `Contents` permission -- the same one that gates `git push` -- which
is *separate* from `Pull requests`. A token scoped to
`pull_requests:write` + `contents:read` can open/manage a draft PR but
GitHub's own servers reject any merge attempt with it: a 403 from GitHub,
not a client-side refusal this code added. `git push`ing the branch itself
is a different, already-solved concern: per D1 (single-user/dogfood), the
real `scoped-fixer` CLI session pushes its own feature branch using whatever
ambient git credentials are already configured on the operator's machine
(see the "push your own branch" addition to `implementer.md`) -- the scoped
PR token is used *only* for `gh`/GitHub-API calls, never for `git push`.

Tested against a **from-scratch local stub** (`LocalGhStub`, backed by a
real local bare git repo -- not a wrapper around real `gh`) that implements
the exact same shared `requireScope()` check `RealGhClient` does, so a test
against the stub is a test of the real permission logic, not a mock that
passes vacuously:
- `packages/implement/test/pr.test.ts` "CORE REQUIREMENT": a credential
  missing `contents:write` calling `mergePr` throws `GhPermissionError`,
  and `main`'s SHA in the bare repo is verified byte-for-byte unchanged
  afterward (the git data layer, not just the thrown error).
- "CONTRAST": the *same* PR, merged with a credential that *does* have
  `contents:write` (explicitly commented as "what a human's own token looks
  like -- never what `pros` itself is given"), actually moves `main` --
  proving the rejection above is a real rejection, not an unconditional
  stub no-op.
- `packages/implement/test/e2e-m4.test.ts` (the full M4 acceptance test,
  see below) repeats this against the exact credential that opened the
  real draft PR in that run.

`RealGhClient.mergePr` exists (rather than being simply absent) specifically
so the boundary is provable end-to-end -- the production Gate 2 pipeline
never calls it, but the thing that actually matters is that the *token*
cannot merge even if something did try.

## Concurrency lease + token ceilings (D21's cost mechanism)

`@pros/lease`'s `ConcurrencyLease` is disk-durable (one JSON file per
runId under a lease directory), mkdir-lock-guarded for the race-safety
property proven in `packages/lease/test/concurrency-lease.test.ts` (two
concurrent `acquire()` calls at `maxConcurrent: 1` resolve to exactly one
success, never both), and self-heals from a crash: a lease whose heartbeat
goes stale is excluded from the count on the next `acquire()` even if
nobody ever called `release()`. `TokenCeiling` is a simple in-memory
accumulator (`record()` throws `TokenCeilingExceededError` once the
cumulative total would exceed the ceiling); `runGate2Pipeline` threads one
`tokenCeiling` instance through implement/verify/review so a single run's
total spend is bounded across all three model-driving stages.
`runGate2Pipeline`'s `leaseDir`/`maxConcurrent` options wrap the whole
pipeline in an acquire/heartbeat/release, mirroring `Barrier.startAttempt`'s
own unref'd heartbeat-timer discipline.

## `pros reconcile`

`packages/cli/src/reconcile.ts`. Recovers three things caught mid-flight, in
one command:
1. **Worktrees** -- `@pros/worktree`'s existing (M2) `WorktreeAllocator.reconcile()`, unchanged, called with `repoRoot` unused (each allocation's own journal entry carries its real `repoRoot`).
2. **Leases** -- `ConcurrencyLease.reconcileStale()`.
3. **In-flight PR ops** -- `@pros/implement`'s `reconcilePrOps`: scans every run's journal for a `pr_create_intent` with no matching `pr_created`, and asks `gh` (`findPrForBranch`, new method on `GhClient`) whether the PR actually exists. If yes, adopts it (synthesizes `pr_created`); if no, reports `needsManualRetry` (deliberately never auto-retries `gh pr create` -- "did creation already run" isn't reliably derivable after a crash). If `PROS_GH_PR_TOKEN` isn't set, this step is skipped and reported as skipped rather than failing worktree/lease recovery, which must not be held hostage by an optional credential.

Tested in `packages/cli/test/reconcile.test.ts`: an intent-only worktree
allocation is adopted (not destroyed), a stale lease is freed and a fresh
acquire then succeeds, and a `pr_create_intent` whose PR genuinely exists
(via a `LocalGhStub`) is adopted with a synthesized `pr_created` entry.

## Deviations and judgment calls, called out explicitly

1. **`pr_create_intent`/`pr_created` are NOT added to `@pros/barrier`'s closed `JournalEntry` union.** Per D12's tolerant-parsing house style, `pipeline.ts` writes/reads them as loosely-typed records via `Journal.append()`/`Journal.read()` directly, relying on the existing "unknown kinds pass through untouched" behavior in `run-state.ts`. This was a deliberate choice to avoid growing `@pros/barrier`'s core type surface for a PR-specific concern; if a future milestone wants these first-class (e.g. surfaced in the dashboard), promote them then.
2. **Worktree reaping is opt-in** (`reapWorktreeOnSuccess` + `worktreeParentRepo` options on `runGate2Pipeline`, both default off/absent). The Gate 2 pipeline's `repoRoot` option is used for loading `.claude/agents`/`.claude/skills` briefs and is *not necessarily* the worktree's actual git parent -- real orchestration call sites (the CLI, the M4 e2e test) pass both `reapWorktreeOnSuccess: true` and the correct `worktreeParentRepo`. Reaping is best-effort: a failure is recorded (`worktreeReapError`) but never fails the pipeline or loses the already-succeeded PR/Gate-2 checkpoint -- an unreaped worktree is left for a future `pros reconcile` pass to find.
3. **`implementer.md` was extended, during integration, with explicit "push your own branch"/"never push to main or a protected branch" guidance** -- the original brief said "never push to a shared remote's protected branch" but didn't say the implementer *should* push its own feature branch, which the Gate 2 pipeline's draft-PR step depends on (branch-push is deliberately NOT something `pr.ts`/`pipeline.ts` does itself, per D1).
4. **`ghCredential` derivation**: if a caller of `runGate2Pipeline` doesn't pass one explicitly, it's derived from `git remote get-url origin` in the worktree + `loadCredentialFromEnv`. Every test in this milestone passes an explicit credential (avoids needing a real GitHub-shaped remote).
5. **`StaleVerificationError`** is exported from `verify.ts` for API-sketch completeness but intentionally never thrown -- the actual stale-fence signal is `StaleFenceError` from `@pros/barrier`, reused rather than duplicated, so callers across the whole pipeline can catch one error type.

## Known gaps

- **No automatic Gate 1 -> Gate 2 continuation.** Exactly like M3's own documented gap (`pros plan`'s pipeline doesn't auto-resume after a crash), there is no daemon that watches for a Gate 1 "approve" answer and automatically invokes `runGate2Pipeline`. Today, whatever calls `pros answer <id> approve ...` is also responsible for then driving Gate 2 (directly via `@pros/implement`'s `runGate2Pipeline`, or a future `pros implement <run-id>` CLI verb -- not built this milestone; there was no first-class CLI wiring requested beyond `pros reconcile`, and the existing `runPlanCommand`/`runAnswerCommand` pattern was matched for `reconcile` only).
- **`pros reconcile`'s PR-ops step needs `PROS_GH_PR_TOKEN`** to actually run; without it, that one sub-check is skipped (reported, not silently dropped) while worktree/lease recovery still runs.
- **Session graph / review-page rendering, learning loop, ambient triggers** remain out of scope, per the roadmap (M5/M6/M7).
- **Dashboard was not extended** to show Gate 2/PR state -- M4's brief scoped that to M5 ("session graph + review page"). `@pros/notify`'s `pr_review` gate type and `@pros/barrier`'s `prRef` are there for M5 to read.

## Acceptance criteria -> tests

| Criterion (from the milestone plan) | Test |
|---|---|
| Multi-worktree execution, orchestrator-allocated | `packages/worktree/test/*.test.ts` (M2, unchanged, still exercised): concurrent allocations never collide. `packages/lease/test/concurrency-lease.test.ts` proves the concurrency *cap* itself is race-safe. |
| Sonnet `scoped-fixer`, implementer base class written | `packages/agents/test/load-brief.test.ts`: `implementer.md`/`scoped-fixer.md` parse with `model: sonnet`, `tools` including `Write`/`Edit`; `finder.md` excludes them. |
| Verification in a background session, verdict not stack trace | `packages/implement/test/verify.test.ts`: fresh-session-only, fence-checked before+after, `Verdict`-only return, fails closed on malformed output. |
| Adversarial review is a skill, Codex + `claude ultrareview` | `.claude/skills/review/SKILL.md` (not an agent file). `packages/implement/test/review.test.ts`: blocker from either pass blocks; minor/major don't. |
| Draft PR via `gh`; merge blocked by a scoped, unmerge-capable credential (not a wrapper/prompt) | `packages/implement/test/pr.test.ts` (CORE REQUIREMENT + CONTRAST tests) and the e2e test's final assertion. |
| `pros reconcile` -- worktrees, leases, in-flight PR ops | `packages/cli/test/reconcile.test.ts` (3 tests, one per concern). |
| **End-to-end on a seeded bug; main untouched; worktree reaped** | `packages/implement/test/e2e-m4.test.ts`: seeds a real off-by-one bug, runs Gate 1 (`runPlanPipeline`) to approval, then Gate 2 (`runGate2Pipeline`) with a fake-but-real-git-operating implement session, asserts: the fix is on the pushed branch, `main`'s SHA is byte-for-byte unchanged, the worktree directory is gone from disk AND from `git worktree list`, a post-hoc `reconcile()` reports it `alreadyOk` (not an orphan), and the exact credential that opened the PR cannot merge it. |
| Fence epochs: stale pre-approval result cannot reach verification/PR | `packages/implement/test/verify.test.ts`'s two `StaleFenceError` tests (before-call and during-call). |
| Global concurrency lease + per-run token ceilings bound work | `packages/lease/test/*.test.ts` (12 tests) + `packages/implement/test/implement.test.ts`'s `TokenCeilingExceededError` propagation test. |
| `env \| grep -iE 'ANTHROPIC\|OPENAI'` stays empty | Re-checked manually this pass: only incidental substring matches in `PATH`/`CLAUDE_PLUGIN_DATA` (plugin directory names containing "openai"), no actual API-billing credential env var. Already covered by `packages/plan/test`'s standing-check test (M2/M3, still passing). |
| `pnpm -r test` stays green for M1-M3, no regressions | Full `pnpm -r --no-bail test` run this pass: **all 12 tested packages, 0 failures.** |

## How to run everything

```bash
pnpm install
pnpm -r typecheck   # 13 packages, clean
pnpm -r test        # generous timeout recommended: 300000-600000ms (mcp/plan's real-CLI acceptance tests each budget ~60s)
```

Package-by-package test counts this pass: adapters 5, agents 7, lease 12,
barrier 20, index 5, worktree 6, notify 9, mcp 12 pass + 1 skip (real-CLI,
documented as load-sensitive since M1), plan 16, dashboard 25, implement 27
(incl. the M4 e2e test), cli 6. Total: **145 passing, 1 skipped, 0 failing**.

To exercise `pros reconcile` for real:
```bash
export PROS_RUNS_DIR=~/.pros/runs
export PROS_WORKTREES_DIR=~/.pros/worktrees
export PROS_LEASE_DIR=~/.pros/leases        # new in M4, defaults to this
export PROS_GH_PR_TOKEN=<fine-grained PAT>  # optional -- see "the merge boundary" above; PR-ops recovery is skipped (not failed) if unset
pros reconcile [--stale-after=<ms>]         # default 60000
```

## What the user must provision manually

1. **A fine-grained GitHub PAT**, scoped to exactly one repository, with
   `Pull requests: Read and write`, `Contents: Read-only`, `Metadata:
   Read-only` -- see "The merge boundary" above for the precise steps and
   why this specific split holds against real GitHub. Store it as
   `PROS_GH_PR_TOKEN` (optionally `PROS_GH_PR_SCOPES`, comma-separated;
   defaults to the three scopes above).
2. Everything M1-M3 already required (`PROS_NTFY_URL`, `PROS_RUNS_DIR`,
   `PROS_WORKTREES_DIR`, `PROS_INDEX_DB` -- see `docs/06-m3-implementation-log.md`).
3. `PROS_LEASE_DIR` (new, optional, defaults to `<HOME>/.pros/leases`) and
   whatever `maxConcurrent`/`maxTotalTokens` values the operator wants to
   pass into `runGate2Pipeline` -- there is no built-in default ceiling
   baked into the pipeline itself; a caller (a future `pros implement` CLI
   verb, not built this milestone) must choose one.

Nothing in this milestone touches the user's real GitHub account, real
credentials, or a real remote -- every test above runs against local bare
git repos and `LocalGhStub`.
