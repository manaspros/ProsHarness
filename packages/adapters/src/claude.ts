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

export function spawnClaude(opts: SpawnOptions): SpawnResult {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  const result = spawnCli({
    command: "claude",
    args,
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
