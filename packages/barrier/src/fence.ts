import type { Journal } from "./journal.js";

/**
 * A lease alone is insufficient: after expiry two recovery workers can both
 * believe they own a worktree. Every state transition, MCP call, verification
 * result and PR operation carries the current fence epoch, and stale-epoch
 * operations are rejected. The epoch increments on amendment, on recovery,
 * and on lease takeover.
 */
export class Fence {
  private epoch: number;

  constructor(
    private readonly journal: Journal,
    private readonly runId: string,
    initialEpoch = 0,
  ) {
    this.epoch = initialEpoch;
  }

  current(): number {
    return this.epoch;
  }

  async bump(reason: string): Promise<number> {
    const previousEpoch = this.epoch;
    this.epoch += 1;
    await this.journal.append({
      runId: this.runId,
      fenceEpoch: this.epoch,
      kind: "fence_bumped",
      previousEpoch,
      newEpoch: this.epoch,
      reason,
    });
    return this.epoch;
  }

  /** Throws if `epoch` is not the current fence epoch. Callers must not act on the operation. */
  async check(epoch: number, op: string): Promise<void> {
    if (epoch !== this.epoch) {
      await this.journal.append({
        runId: this.runId,
        fenceEpoch: this.epoch,
        kind: "rejected_stale",
        attemptedFenceEpoch: epoch,
        currentFenceEpoch: this.epoch,
        op,
      });
      throw new StaleFenceError(op, epoch, this.epoch);
    }
  }
}

export class StaleFenceError extends Error {
  constructor(
    public readonly op: string,
    public readonly attemptedEpoch: number,
    public readonly currentEpoch: number,
  ) {
    super(`stale fence epoch for ${op}: attempted=${attemptedEpoch} current=${currentEpoch}`);
    this.name = "StaleFenceError";
  }
}
