// Adapter for the real `codex` CLI, driven as a subprocess (never the API
// directly — subscription billing only). See docs/01-m0-results.md for the
// measured NDJSON event shapes this parser is built against.
//
// Gotcha (measured, see docs/01-m0-results.md): global flags such as
// `--sandbox`/`-c`/`--json` MUST precede the `resume` subcommand, or codex
// exits with code 2 ("unexpected argument found"). We build args as
// `["exec", "--json", ...extraArgs, "resume", sessionId, "-"]` when
// resuming, vs `["exec", "--json", ...extraArgs, "-"]` otherwise — `extraArgs`
// (schema flags etc.) always sits between `--json` and the `resume`
// subcommand, matching `codex exec [OPTIONS] <COMMAND>` usage.
//
// Prompt delivery: `codex exec --help` / `codex exec resume --help` confirm
// PROMPT is a positional argument that reads from stdin when given as `-`
// (and stdin is *always* read when `-` is passed, even though a bare
// positional prompt is also technically supported). We always pass `-` and
// pipe the prompt over stdin for both the fresh and resume cases, so
// behavior is uniform and avoids argv escaping/length issues.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnCli } from "./spawn-common.js";
import type { ParsedEvent, SpawnOptions, SpawnResult } from "./types.js";

const execFileAsync = promisify(execFile);

// Flat top-level `type` values observed/expected from `codex exec --json`
// (docs/01-m0-results.md). Anything else valid-JSON is "unknown_type"
// (recorded, not dropped); anything failing JSON.parse is "malformed".
const KNOWN_CODEX_TYPES = new Set(["thread.started", "turn.started", "item.completed", "turn.completed", "turn.failed"]);

export function parseCodexLine(raw: string, seq: number): ParsedEvent {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { provider: "codex", seq, raw, parseStatus: "malformed" };
  }

  const type =
    typeof data === "object" && data !== null && "type" in data && typeof (data as { type: unknown }).type === "string"
      ? (data as { type: string }).type
      : undefined;

  if (type !== undefined && KNOWN_CODEX_TYPES.has(type)) {
    return { provider: "codex", seq, raw, parseStatus: "ok", type, data };
  }
  return { provider: "codex", seq, raw, parseStatus: "unknown_type", type, data };
}

export function buildCodexArgs(
  opts: Pick<SpawnOptions, "resumeSessionId" | "dangerouslySkipPermissions" | "extraArgs">,
): string[] {
  const args = ["exec", "--json"];
  if (opts.dangerouslySkipPermissions) {
    // Automated review has no interactive approval channel. Without this,
    // Codex can terminate a turn with `turn.failed` while waiting for an
    // approval that the orchestrator cannot provide.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId, "-");
  } else {
    args.push("-");
  }
  return args;
}

export function spawnCodex(opts: SpawnOptions): SpawnResult {
  const args = buildCodexArgs(opts);

  const result = spawnCli({
    command: "codex",
    args,
    provider: "codex",
    opts,
    parseLine: parseCodexLine,
  });

  // Best-effort version capture via a separate, fast `codex --version` call
  // (measured: the live NDJSON stream's `thread.started` event does not
  // carry a codex-cli version field, so scraping stream events is not a
  // viable alternative — a dedicated check is simplest and most robust).
  const versionSeen = execFileAsync("codex", ["--version"], { timeout: opts.timeoutMs, killSignal: "SIGKILL" })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");

  return { ...result, versionSeen };
}
