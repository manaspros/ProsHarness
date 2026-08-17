// Shared types for CLI subprocess adapters.
//
// Design note (D12/D24 tolerant-parsing invariant): unknown event `type`s and
// unrecognized fields must NEVER be silently dropped or treated as fatal.
// `ParsedEvent.raw` always preserves the exact line as emitted, and
// `parseStatus` distinguishes "known/ok" from "unknown_type" (valid JSON,
// unrecognized `type`) from "malformed" (not valid JSON at all). Callers can
// always fall back to `raw`/`data` even when the parser doesn't recognize the
// shape.

export type Provider = "claude" | "codex";
export type ParseStatus = "ok" | "unknown_type" | "malformed";

export interface ParsedEvent {
  provider: Provider;
  seq: number; // 0-based line index within this attempt's stream
  raw: string; // the raw text line EXACTLY as emitted (no trailing newline) — never lose this
  parseStatus: ParseStatus;
  type?: string; // e.g. "assistant", "result", "rate_limit_event" (claude) or "thread.started", "turn.completed" (codex), if JSON-parseable
  data?: unknown; // the parsed JSON object, present whenever parseStatus !== "malformed"
}

export interface SpawnOptions {
  cwd: string;
  prompt: string; // piped via stdin to avoid argv length/escaping issues
  resumeSessionId?: string; // claude session id or codex thread id
  /** Permission bypass requested for an unattended model session. */
  dangerouslySkipPermissions?: boolean;
  extraArgs?: string[]; // e.g. ["--json-schema", schemaJson] / ["--output-schema", path]
  env?: Record<string, string>;
  /** Kill the CLI if it does not finish within this many milliseconds. */
  timeoutMs?: number;
  rawLogPath?: string; // if set, append every raw line here as it arrives (verbatim bytes, newline-delimited) — feeds packages/index's SQLite raw_events indexer (a separate package that tails these files, at-least-once, deduping by (attemptId, seq)). We only need to WRITE correctly (append, one line per event); fsync is not required here.
  attemptId: string; // used only to label rawLogPath entries if desired; not required to be parsed
}

export interface SpawnResult {
  child: import("node:child_process").ChildProcess;
  events: AsyncIterable<ParsedEvent>; // async-iterate to consume events as they stream in, in order, seq starting at 0
  exitCode: Promise<number | null>; // resolves when the process exits
  /** Buffered stderr for actionable diagnostics when a CLI turn fails. */
  stderr: Promise<string>;
  versionSeen?: Promise<string>; // best-effort: the CLI's own --version string
}

export const PINNED_VERSIONS: Record<Provider, string> = {
  claude: "2.1.232",
  codex: "0.147.0",
};

export interface VersionCheckResult {
  pinned: string;
  actual: string;
  matches: boolean;
}

/**
 * Compares an observed CLI version string against the pinned version this
 * package's parsers were built/verified against. Never throws — drift is
 * reported, not treated as fatal, so callers can log a warning and continue
 * (the parser's tolerant unknown-type handling is the actual safety net).
 */
export function checkPinnedVersion(provider: Provider, actualVersionString: string): VersionCheckResult {
  const pinned = PINNED_VERSIONS[provider];
  const actual = actualVersionString.trim();
  // Loose match: the pinned version string should appear somewhere in the
  // actual output, since both CLIs prefix/suffix extra text (e.g.
  // "codex-cli 0.147.0", "2.1.232 (Claude Code)").
  const matches = actual.includes(pinned);
  return { pinned, actual, matches };
}
