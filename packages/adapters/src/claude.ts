// Adapter for the real `claude` CLI, driven as a subprocess (never the API
// directly — subscription billing only). See docs/01-m0-results.md for the
// measured NDJSON event shapes this parser is built against.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnCli } from "./spawn-common.js";
import type { ParsedEvent, SpawnOptions, SpawnResult } from "./types.js";

const execFileAsync = promisify(execFile);

// Top-level `type` values observed/expected from `claude -p --output-format
// stream-json --verbose` (docs/01-m0-results.md). Anything else that is
// still valid JSON is "unknown_type" (recorded, not dropped); anything that
// fails JSON.parse is "malformed".
const KNOWN_CLAUDE_TYPES = new Set(["rate_limit_event", "system", "assistant", "user", "result"]);

export function parseClaudeLine(raw: string, seq: number): ParsedEvent {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { provider: "claude", seq, raw, parseStatus: "malformed" };
  }

  const type =
    typeof data === "object" && data !== null && "type" in data && typeof (data as { type: unknown }).type === "string"
      ? (data as { type: string }).type
      : undefined;

  if (type !== undefined && KNOWN_CLAUDE_TYPES.has(type)) {
    return { provider: "claude", seq, raw, parseStatus: "ok", type, data };
  }
  return { provider: "claude", seq, raw, parseStatus: "unknown_type", type, data };
}

export function buildClaudeArgs(
  opts: Pick<
    SpawnOptions,
    "resumeSessionId" | "dangerouslySkipPermissions" | "extraArgs" | "permissionMode" | "allowedTools"
  >,
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  // `dangerouslySkipPermissions` and the scoped `permissionMode`/`allowedTools`
  // grant are mutually exclusive by construction: a full bypass makes an
  // allowlist meaningless, and this branching is also what makes the
  // "never emit --dangerously-skip-permissions for a scoped grant" security
  // property hold structurally rather than by caller discipline alone.
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    if (opts.permissionMode) {
      args.push("--permission-mode", opts.permissionMode);
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // `--allowedTools` is a real CLI variadic flag (confirmed via
      // `claude --help` on 2.1.232: "--allowedTools, --allowed-tools <tools...>
      // Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      // Edit")"); each pattern is one argv element -- spawn() never re-splits
      // these on whitespace, so a pattern like "Bash(git commit *)" survives
      // as a single tool name intact.
      args.push("--allowedTools", ...opts.allowedTools);
    }
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return args;
}

export function spawnClaude(opts: SpawnOptions): SpawnResult {
  const result = spawnCli({
    command: "claude",
    args: buildClaudeArgs(opts),
    provider: "claude",
    opts,
    parseLine: parseClaudeLine,
  });

  // Best-effort version capture: `claude --version` is a fast, separate,
  // side-effect-free invocation. We measured (docs/01-m0-results.md) that
  // claude does not reliably echo its own version inline in the NDJSON
  // stream (the `system`/`init` event does not carry a stable `version`
  // field we want to depend on), so a dedicated `--version` check is the
  // more robust choice over scraping stream events.
  const versionSeen = execFileAsync("claude", ["--version"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");

  return { ...result, versionSeen };
}
