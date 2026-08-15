import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Journal } from "./journal.js";
import { Guardian } from "./guardian.js";
import { Fence, StaleFenceError } from "./fence.js";
import { snapshotManifest, computeHeadSha, readManifest } from "./manifest.js";
import { loadRunState, type RunState } from "./run-state.js";
import type { AnswerEffect, LaunchConfig } from "./types.js";

export { StaleFenceError };

export interface StartAttemptOptions {
  launchConfig: LaunchConfig;
  heartbeatStaleMs?: number;
  /** Override the generated attempt id. Needed when a caller must reference the attempt id before launch (e.g. baking it into an MCP server's env). */
  attemptId?: string;
}

export interface CheckpointRequest {
  attemptId: string;
  questionId: string;
  idempotencyKey: string;
  prompt: string;
  options: string[];
  /** Which human gate this is. Defaults to "ask_human" if not given, so existing ask-human.ts call sites need zero changes. */
  gateType?: "ask_human" | "plan_approval" | "pr_review";
  /** Present only when gateType is "plan_approval". */
  planRef?: { planId: string; version: number };
  /** Present only when gateType is "pr_review". */
  prRef?: { url: string; number: number; headSha: string };
}

type ParkedListener = (info: {
  runId: string;
  checkpointId: string;
  questionId: string;
  gateType: "ask_human" | "plan_approval" | "pr_review";
  prompt: string;
  planRef?: { planId: string; version: number };
  prRef?: { url: string; number: number; headSha: string };
}) => void;

/**
 * The standalone checkpoint-barrier supervisor (M1's first commit).
 *
 * Owns, per run: the journal, the fence epoch, and one live Guardian per
 * attempt. Implements the exact 5-step checkpoint sequence from
 * docs/03-architecture.md and the "safe to checkpoint is a precondition"
 * deferral rule.
 */
export class Barrier {
  private guardians = new Map<string, Guardian>();
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private unsafeSections = new Set<string>();
  /** checkpointIds this instance has already started (or finished) processing, so the poller never double-quiesces one. */
  private claimed = new Set<string>();
  /**
   * checkpointId -> the in-flight `proceedCheckpoint` promise for whichever
   * `pollOnce()` invocation actually claimed it. `pollOnce()` runs both from
   * the free-running 20ms timer AND inline from `requestCheckpoint()` (to
   * keep the same-process path snappy -- see there), so two invocations can
   * overlap: one's `loadRunState()` resolves and reaches the claim first,
   * the other sees "already claimed" and would otherwise return immediately
   * having done nothing. Without this map that second invocation -- which
   * may be the one a caller (e.g. `requestCheckpoint()`, and transitively
   * the caller of that) is actually awaiting -- resolves before the freeze
   * +kill+snapshot+parked sequence the FIRST invocation kicked off has
   * actually finished, so `barrier.close()` and any fresh disk read right
   * after can race ahead of it. Recording the promise here lets any loser
   * of the claim race wait for the real winner's work instead of assuming
   * "someone else has it" means "it's already done".
   */
  private inFlight = new Map<string, Promise<void>>();
  /** checkpointIds this instance has already logged a `checkpoint_deferred` entry for, so re-observing "still unsafe" doesn't spam the journal. */
  private loggedDeferrals = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private state: RunState;
  private parkedListeners: ParkedListener[] = [];

  private constructor(
    public readonly runDir: string,
    public readonly runId: string,
    private readonly journal: Journal,
    public readonly fence: Fence,
    initialState: RunState,
  ) {
    this.state = initialState;
  }

  static async open(runDir: string, runId: string): Promise<Barrier> {
    const journal = await Journal.open(runDir);
    const initialState = await loadRunState(runDir);
    const fence = new Fence(journal, runId, initialState.fenceEpoch);
    const barrier = new Barrier(runDir, runId, journal, fence, initialState);
    barrier.startPoller();
    return barrier;
  }

  getState(): RunState {
    return this.state;
  }

  async close(): Promise<void> {
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.journal.close();
  }

  /**
   * A `checkpoint_requested` entry can be durably appended by a DIFFERENT
   * OS process than the one holding the attempt's live Guardian -- e.g. an
   * ask_human MCP server subprocess appends the intent, but only the
   * process that actually called startAttempt (the daemon/test harness)
   * holds the in-memory Guardian needed to freeze and kill it. So instead
   * of proceeding inline, every requested checkpoint is picked up by this
   * poll loop, which only acts on attempts THIS instance actually guards.
   * That is what makes `ask_human` safe to call from a separate process:
   * the intent becomes durable immediately (cross-process, via the
   * journal), and whichever process actually owns the guardian is the one
   * that carries out the freeze+kill+snapshot+parked sequence.
   */
  private startPoller(): void {
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => undefined);
    }, 20);
    this.pollTimer.unref();
  }

  private async pollOnce(): Promise<void> {
    if (this.guardians.size === 0) return;
    this.state = await loadRunState(this.runDir);
    for (const cp of this.state.checkpoints.values()) {
      if (cp.phase !== "checkpoint_requested") continue;
      if (!this.guardians.has(cp.attemptId)) continue; // not ours to enforce
      if (this.claimed.has(cp.checkpointId)) continue;

      if (!this.isSafeToCheckpoint()) {
        if (!this.loggedDeferrals.has(cp.checkpointId)) {
          this.loggedDeferrals.add(cp.checkpointId);
          await this.journal.append({
            runId: this.runId,
            fenceEpoch: this.fence.current(),
            kind: "checkpoint_deferred",
            checkpointId: cp.checkpointId,
            reason: `unsafe sections held: ${[...this.unsafeSections].join(",")}`,
          });
        }
        continue;
      }

      this.claimed.add(cp.checkpointId);
      const req: CheckpointRequest = {
        attemptId: cp.attemptId,
        questionId: cp.questionId,
        idempotencyKey: cp.idempotencyKey,
        prompt: cp.prompt,
        options: cp.options,
        gateType: cp.gateType,
        planRef: cp.planRef,
      };
      const promise = this.proceedCheckpoint(req, cp.checkpointId).finally(() => {
        this.inFlight.delete(cp.checkpointId);
      });
      this.inFlight.set(cp.checkpointId, promise);
      await promise;
    }
  }

  /** Test-only fault injection (kill-test #10): see Journal.simulateIOFailureOnce. */
  simulateJournalIOFailureOnce(): void {
    this.journal.simulateIOFailureOnce();
  }

  // ---- attempt lifecycle -------------------------------------------------

  async startAttempt(opts: StartAttemptOptions): Promise<{ attemptId: string; guardian: Guardian }> {
    const attemptId = opts.attemptId ?? randomUUID();
    const unitName = `pros-${this.runId}-${attemptId}`.slice(0, 63).replace(/[^a-zA-Z0-9-]/g, "-");
    const heartbeatFile = path.join(this.runDir, `heartbeat-${attemptId}`);
    const launchConfigHash = createHash("sha256").update(JSON.stringify(opts.launchConfig)).digest("hex");

    const guardian = await Guardian.launch(opts.launchConfig.command, opts.launchConfig.args, {
      cwd: opts.launchConfig.cwd,
      unitName,
      heartbeatFile,
      heartbeatStaleMs: opts.heartbeatStaleMs,
      env: opts.launchConfig.env ? { ...process.env, ...opts.launchConfig.env } : undefined,
    });

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "attempt_started",
      attemptId,
      cwd: opts.launchConfig.cwd,
      launchConfigHash,
      unitName,
    });

    this.guardians.set(attemptId, guardian);

    // The watchdog fails closed on a stale heartbeat (kill-test #2) -- but
    // that guarantee is only useful if something keeps the heartbeat fresh
    // for as long as the attempt is legitimately alive. In the real system
    // that's the daemon's supervision loop; M1 has no standalone daemon
    // process yet, so the Barrier plays that role in-process: it pumps the
    // heartbeat until the attempt ends, and stopping (crash, close()) is
    // exactly what should make the watchdog treat it as abandoned.
    const staleMs = opts.heartbeatStaleMs ?? 5000;
    const timer = setInterval(() => {
      guardian.heartbeat().catch(() => undefined);
    }, Math.max(250, Math.floor(staleMs / 3)));
    timer.unref();
    this.heartbeatTimers.set(attemptId, timer);

    this.state = await loadRunState(this.runDir);
    return { attemptId, guardian };
  }

  async endAttempt(attemptId: string, exitReason: string): Promise<void> {
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "attempt_ended",
      attemptId,
      exitReason,
    });
    const timer = this.heartbeatTimers.get(attemptId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(attemptId);
    }
    this.guardians.delete(attemptId);
    this.state = await loadRunState(this.runDir);
  }

  guardianFor(attemptId: string): Guardian | undefined {
    return this.guardians.get(attemptId);
  }

  /**
   * Register a callback fired (fire-and-forget, NEVER awaited by the barrier
   * sequence, NEVER able to throw into it) every time this Barrier instance
   * parks a checkpoint -- via EITHER `proceedCheckpoint` OR `parkForGate1`.
   * Returns an unsubscribe function. Used by @pros/notify to push an ntfy
   * notification without any possibility of a slow/failing notifier wedging
   * the barrier sequence (an explicit M3 requirement: "a failed push must
   * never wedge a run or lose a question").
   */
  onParked(cb: ParkedListener): () => void {
    this.parkedListeners.push(cb);
    return () => {
      this.parkedListeners = this.parkedListeners.filter((l) => l !== cb);
    };
  }

  private fireParked(info: Parameters<ParkedListener>[0]): void {
    // Fire-and-forget: scheduled on a microtask, wrapped in try/catch. A
    // thrown or rejected callback must never propagate back into the caller
    // of proceedCheckpoint/parkForGate1 -- notification is corroborating,
    // never load-bearing for the barrier sequence itself.
    for (const cb of this.parkedListeners) {
      Promise.resolve()
        .then(() => cb(info))
        .catch(() => undefined);
    }
  }

  // ---- safe-to-checkpoint critical section -------------------------------

  async enterUnsafeSection(sectionId: string): Promise<void> {
    this.unsafeSections.add(sectionId);
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "safe_section_enter",
      sectionId,
    });
  }

  async exitUnsafeSection(sectionId: string): Promise<void> {
    this.unsafeSections.delete(sectionId);
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "safe_section_exit",
      sectionId,
    });
    // Any checkpoint that was deferred while unsafe gets picked up by the
    // poller on its next tick (within 20ms); no need to special-case it here.
  }

  isSafeToCheckpoint(): boolean {
    return this.unsafeSections.size === 0;
  }

  // ---- the checkpoint sequence -------------------------------------------

  /**
   * Entry point for `ask_human`. Never resolves with "the question was
   * answered" -- callers (the MCP tool handler) must not treat this
   * resolving as permission to keep going; it only means the intent is
   * durable. The daemon, not the tool, is what freezes the attempt.
   */
  async requestCheckpoint(req: CheckpointRequest): Promise<{ checkpointId: string; deferred: boolean }> {
    const existing = this.state.idempotencyIndex.get(req.idempotencyKey);
    if (existing) {
      // A replayed tool call after a crash must not mint a second question.
      return { checkpointId: existing, deferred: false };
    }

    const checkpointId = randomUUID();

    // Step 1: durable-append the checkpoint intent and fsync, BEFORE any
    // containment action, so a crash right after this point still leaves a
    // recoverable record that a checkpoint was requested. This is the ONLY
    // step this method performs -- see startPoller() for why steps 2-5
    // happen out of band rather than inline.
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "checkpoint_requested",
      checkpointId,
      attemptId: req.attemptId,
      questionId: req.questionId,
      idempotencyKey: req.idempotencyKey,
      prompt: req.prompt,
      options: req.options,
      gateType: req.gateType ?? "ask_human",
      planRef: req.planRef,
    });
    this.state = await loadRunState(this.runDir);

    // If this instance owns the attempt's guardian, kick the poller
    // immediately instead of waiting up to 20ms -- keeps the common
    // (same-process) path snappy. If it doesn't own the guardian (an
    // ask_human subprocess calling in), the OWNING process's poller is
    // solely responsible, on its own schedule, and this call cannot know
    // yet whether it will be deferred.
    let deferred = false;
    if (this.guardians.has(req.attemptId)) {
      await this.pollOnce();
      // The free-running 20ms timer's own pollOnce() tick can overlap this
      // one and win the race to claim this exact checkpoint (its
      // loadRunState() happened to resolve first) -- in that case OUR
      // pollOnce() above saw "already claimed" and returned without doing
      // anything, even though the real freeze+kill+snapshot+parked sequence
      // is still running in that other invocation. Wait for it here so this
      // method never returns before the checkpoint has actually reached its
      // resting phase (parked or still-deferred) -- callers like
      // `Barrier.close()` right after this must not be able to race ahead
      // of it.
      const inFlight = this.inFlight.get(checkpointId);
      if (inFlight) await inFlight;
      this.state = await loadRunState(this.runDir);
      deferred = this.state.checkpoints.get(checkpointId)?.phase === "checkpoint_requested";
    }

    return { checkpointId, deferred };
  }

  private async proceedCheckpoint(req: CheckpointRequest, checkpointId: string): Promise<void> {
    const guardian = this.guardians.get(req.attemptId);
    if (!guardian) throw new Error(`no guardian for attempt ${req.attemptId}`);

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "quiescing",
      checkpointId,
      attemptId: req.attemptId,
    });

    // Step 2+3: freeze the boundary before any successful tool response
    // reaches the model, then confirm it is actually empty.
    const { wasEmpty } = await guardian.quiesce();
    if (!wasEmpty) {
      // quiesce() already waited out its timeout; surface this rather than
      // silently declaring parked over a boundary that might not be empty.
      throw new Error(`containment boundary for attempt ${req.attemptId} did not empty in time`);
    }

    const attempt = this.state.attempts.get(req.attemptId);
    if (!attempt) throw new Error(`unknown attempt ${req.attemptId}`);

    // Step 4: snapshot the manifest -- HEAD, base SHA, and a working-state
    // hash covering staged+unstaged+untracked -- and fsync it.
    const baseSha = await computeHeadSha(attempt.cwd); // base SHA at start would be tracked by a real caller; identity here for M1
    const manifest = await snapshotManifest(this.runDir, {
      runId: this.runId,
      cwd: attempt.cwd,
      baseSha,
      fenceEpoch: this.fence.current(),
      launchConfig: {
        provider: "fixture",
        command: "",
        args: [],
        cwd: attempt.cwd,
      },
    });

    // Step 5: durable-append `parked`. Only now is the run actually parked.
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "parked",
      checkpointId,
      attemptId: req.attemptId,
      manifestPath: path.join(this.runDir, "manifest.json"),
      workingStateHash: manifest.workingStateHash,
    });

    this.fireParked({
      runId: this.runId,
      checkpointId,
      questionId: req.questionId,
      gateType: req.gateType ?? "ask_human",
      prompt: req.prompt,
      planRef: req.planRef,
    });

    await this.endAttempt(req.attemptId, "parked");
    this.state = await loadRunState(this.runDir);
  }

  /**
   * Parks a run for a human gate when there is NO live attempt/guardian to
   * freeze -- e.g. `pros plan`'s pipeline, where the finding/debate model
   * calls have already completed by the time the plan needs Gate 1
   * approval. Skips guardian quiesce (there is nothing running to quiesce)
   * but performs every other step of the barrier sequence: durable intent,
   * manifest snapshot (staged+unstaged+untracked), durable `parked`.
   * Idempotent on `idempotencyKey` exactly like `requestCheckpoint`.
   */
  async parkForGate1(opts: {
    cwd: string;
    prompt: string;
    options: string[];
    questionId: string;
    idempotencyKey: string;
    planRef: { planId: string; version: number };
  }): Promise<{ checkpointId: string }> {
    // Idempotency check, same as requestCheckpoint: a replayed call after a
    // crash must not mint a second question.
    const existing = this.state.idempotencyIndex.get(opts.idempotencyKey);
    if (existing) {
      return { checkpointId: existing };
    }

    const checkpointId = randomUUID();
    const attemptId = "gate1-pipeline"; // synthetic: no live attempt/guardian backs a plan-approval gate

    // Step 1: durable-append the checkpoint intent, before any other action.
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "checkpoint_requested",
      checkpointId,
      attemptId,
      questionId: opts.questionId,
      idempotencyKey: opts.idempotencyKey,
      prompt: opts.prompt,
      options: opts.options,
      gateType: "plan_approval",
      planRef: opts.planRef,
    });

    // Step 2 (no-op here): there is no live containment boundary to freeze.
    // Step 3 (no-op here): nothing to quiesce -- still record the transition
    // for a consistent phase progression in the journal/RunState.
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "quiescing",
      checkpointId,
      attemptId,
    });

    // Step 4: snapshot the manifest -- HEAD, base SHA, and a working-state
    // hash covering staged+unstaged+untracked -- and fsync it.
    const baseSha = await computeHeadSha(opts.cwd);
    const manifest = await snapshotManifest(this.runDir, {
      runId: this.runId,
      cwd: opts.cwd,
      baseSha,
      fenceEpoch: this.fence.current(),
      launchConfig: {
        provider: "fixture",
        command: "",
        args: [],
        cwd: opts.cwd,
      },
    });

    // Step 5: durable-append `parked`. Only now is the run actually parked.
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "parked",
      checkpointId,
      attemptId,
      manifestPath: path.join(this.runDir, "manifest.json"),
      workingStateHash: manifest.workingStateHash,
    });

    this.fireParked({
      runId: this.runId,
      checkpointId,
      questionId: opts.questionId,
      gateType: "plan_approval",
      prompt: opts.prompt,
      planRef: opts.planRef,
    });

    this.state = await loadRunState(this.runDir);
    return { checkpointId };
  }

  /**
   * Parks a run for Gate 2 (M4 human review of a draft PR) -- structurally
   * identical to `parkForGate1` (no live attempt/guardian to freeze by the
   * time a draft PR exists; implementation/verification/review were one-shot
   * ModelSession/CLI calls), just with `gateType: "pr_review"` and a
   * `prRef` instead of a `planRef`. Idempotent on `idempotencyKey`.
   */
  async parkForGate2(opts: {
    cwd: string;
    prompt: string;
    options: string[];
    questionId: string;
    idempotencyKey: string;
    prRef: { url: string; number: number; headSha: string };
  }): Promise<{ checkpointId: string }> {
    const existing = this.state.idempotencyIndex.get(opts.idempotencyKey);
    if (existing) {
      return { checkpointId: existing };
    }

    const checkpointId = randomUUID();
    const attemptId = "gate2-pipeline"; // synthetic: no live attempt/guardian backs a PR-review gate

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "checkpoint_requested",
      checkpointId,
      attemptId,
      questionId: opts.questionId,
      idempotencyKey: opts.idempotencyKey,
      prompt: opts.prompt,
      options: opts.options,
      gateType: "pr_review",
      prRef: opts.prRef,
    });

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "quiescing",
      checkpointId,
      attemptId,
    });

    const baseSha = await computeHeadSha(opts.cwd);
    const manifest = await snapshotManifest(this.runDir, {
      runId: this.runId,
      cwd: opts.cwd,
      baseSha,
      fenceEpoch: this.fence.current(),
      launchConfig: {
        provider: "fixture",
        command: "",
        args: [],
        cwd: opts.cwd,
      },
    });

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "parked",
      checkpointId,
      attemptId,
      manifestPath: path.join(this.runDir, "manifest.json"),
      workingStateHash: manifest.workingStateHash,
    });

    this.fireParked({
      runId: this.runId,
      checkpointId,
      questionId: opts.questionId,
      gateType: "pr_review",
      prompt: opts.prompt,
      prRef: opts.prRef,
    });

    this.state = await loadRunState(this.runDir);
    return { checkpointId };
  }

  // ---- answers ------------------------------------------------------------

  async recordAnswer(
    checkpointId: string,
    questionId: string,
    idempotencyKey: string,
    answer: string,
    effect: AnswerEffect,
  ): Promise<void> {
    const cp = this.state.checkpoints.get(checkpointId);
    if (!cp) throw new Error(`unknown checkpoint ${checkpointId}`);
    if (cp.phase !== "parked") {
      // answer_rejected_stale: the run already moved past this checkpoint.
      throw new StaleAnswerError(checkpointId, cp.phase);
    }

    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "answered",
      checkpointId,
      questionId,
      idempotencyKey,
      answer,
      effect,
    });

    if (effect === "requires_plan_amendment" || effect === "abort") {
      await this.fence.bump(`answer effect: ${effect}`);
    }
    this.state = await loadRunState(this.runDir);
  }

  // ---- resume ---------------------------------------------------------------

  async claim(checkpointId: string): Promise<void> {
    const cp = this.state.checkpoints.get(checkpointId);
    if (!cp || cp.phase !== "answered") throw new Error(`checkpoint ${checkpointId} not answered`);
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "claimed",
      checkpointId,
    });
    this.state = await loadRunState(this.runDir);
  }

  /**
   * Resume must always launch from the manifest's recorded cwd, never from
   * whatever directory the caller happens to be in and never trusting the
   * agent's own conversational memory of where it was.
   */
  async resume(checkpointId: string): Promise<{ attemptId: string; cwd: string }> {
    const cp = this.state.checkpoints.get(checkpointId);
    if (!cp || cp.phase !== "claimed") throw new Error(`checkpoint ${checkpointId} not claimed`);

    const manifest = await readManifest(this.runDir);
    if (!manifest) throw new Error("no manifest to resume from");

    const newAttemptId = randomUUID();
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "resuming",
      checkpointId,
      newAttemptId,
      cwd: manifest.cwd,
    });
    this.state = await loadRunState(this.runDir);
    return { attemptId: newAttemptId, cwd: manifest.cwd };
  }

  async consume(checkpointId: string, newAttemptId: string): Promise<void> {
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.fence.current(),
      kind: "consumed",
      checkpointId,
      newAttemptId,
    });
    this.state = await loadRunState(this.runDir);
  }
}

export class StaleAnswerError extends Error {
  constructor(
    public readonly checkpointId: string,
    public readonly phase: string,
  ) {
    super(`checkpoint ${checkpointId} is not parked (phase=${phase}); answer rejected as stale`);
    this.name = "StaleAnswerError";
  }
}
