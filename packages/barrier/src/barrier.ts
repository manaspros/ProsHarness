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
}

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
  /** checkpointIds this instance has already logged a `checkpoint_deferred` entry for, so re-observing "still unsafe" doesn't spam the journal. */
  private loggedDeferrals = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private state: RunState;

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
      };
      await this.proceedCheckpoint(req, cp.checkpointId);
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

    await this.endAttempt(req.attemptId, "parked");
    this.state = await loadRunState(this.runDir);
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
