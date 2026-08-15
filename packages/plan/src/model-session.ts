/**
 * The dependency-injection seam for M2's plan pipeline.
 *
 * docs/05-m2-implementation-log.md's acceptance criterion is explicit: "the
 * 'critique changed the plan' assertion runs against a stubbed fixture, not
 * a live model." The only honest way to satisfy that is for every module
 * that drives a model (finding.ts, plan.ts, critique.ts, debate.ts) to take
 * a `ModelSession` as a parameter and never construct `spawnClaude`/
 * `spawnCodex` itself. A test can then inject a `FakeModelSession` that
 * returns canned JSON instantly -- no subprocess, no network, no API key --
 * while `pipeline.ts` (the only place that talks to real CLIs) defaults to
 * the Real* implementations below.
 */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRunOptions {
  cwd: string;
  prompt: string;
  /** When set, the caller expects `text` to be JSON parseable and schema-conforming. */
  schema?: object;
  /** For continuing a session across debate rounds, when the underlying CLI/session supports it. */
  resumeSessionId?: string;
  /** Explicit opt-in for Claude's permission bypass; ignored by other providers. */
  dangerouslySkipPermissions?: boolean;
  rawLogPath?: string;
  attemptId: string;
}

export interface ModelRunResult {
  text: string;
  sessionId?: string;
  usage: ModelUsage;
}

export interface ModelSession {
  readonly provider: "claude" | "codex";
  run(opts: ModelRunOptions): Promise<ModelRunResult>;
}
