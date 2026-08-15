/**
 * The per-run token ceiling (M4, docs/00-decisions.md D21).
 *
 * Bounds how many tokens (input+output) a single run's model calls --
 * implementation, verification, adversarial review -- may cumulatively
 * consume. Unlike `ConcurrencyLease`, this does NOT need to be durable
 * across a process crash for M4's scope: a crash already ends the attempt,
 * and re-running starts a fresh ceiling. So this is a plain in-memory
 * accumulator, not a filesystem-backed record.
 *
 * The shape of `TokenUsage` deliberately matches (structurally, with no
 * import) `packages/plan/src/model-session.ts`'s `ModelUsage` so a caller
 * can pass `result.usage` from a `ModelSession.run()` result straight into
 * `record()` with no adapter code.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export class TokenCeilingExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly ceiling: number,
  ) {
    super(`token ceiling exceeded: used ${used} tokens against a ceiling of ${ceiling}`);
    this.name = "TokenCeilingExceededError";
  }
}

export interface TokenCeilingOptions {
  maxTotalTokens: number;
}

export class TokenCeiling {
  readonly ceiling: number;
  private total = 0;

  constructor(opts: TokenCeilingOptions) {
    this.ceiling = opts.maxTotalTokens;
  }

  /**
   * Adds usage to the running total. Throws `TokenCeilingExceededError` if
   * the NEW total exceeds the ceiling -- the usage that pushed it over is
   * still recorded (so `used()` reflects reality for logging), but the
   * caller must treat the throw as "stop issuing further model calls in
   * this run".
   */
  record(usage: TokenUsage): void {
    this.total += usage.inputTokens + usage.outputTokens;
    if (this.total > this.ceiling) {
      throw new TokenCeilingExceededError(this.total, this.ceiling);
    }
  }

  used(): number {
    return this.total;
  }

  remaining(): number {
    return Math.max(0, this.ceiling - this.total);
  }
}
