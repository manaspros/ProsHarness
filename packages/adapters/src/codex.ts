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

// ---------------------------------------------------------------------------
// Read-only advisory review (Phase 6, verify lane) -- see
// packages/implement/src/review.ts's `runCodexAdvisoryReview`, the only
// caller. Kept in this adapter (not a parallel spawn path in @pros/implement)
// because interpreting codex's own NDJSON event vocabulary is this module's
// job already (parseCodexLine/KNOWN_CODEX_TYPES above).
// ---------------------------------------------------------------------------

/**
 * `--sandbox read-only` is deliberate and load-bearing: given `workspace-write`
 * a second model starts fixing instead of judging, collapsing the
 * finder/implementer/verifier lane split this project relies on. Do not
 * widen this sandbox. `--output-schema` takes a real file path (confirmed
 * against `codex exec --help` on codex-cli 0.147.0: "Path to a JSON Schema
 * file describing the model's final response shape"), not inline JSON --
 * the caller is responsible for writing `outputSchemaPath` to disk first.
 */
export function buildCodexAdvisoryExtraArgs(outputSchemaPath: string): string[] {
  return ["--sandbox", "read-only", "--output-schema", outputSchemaPath];
}

export type CodexAdvisoryOutcomeStatus = "ok" | "turn_failed" | "no_agent_message";

export interface CodexAdvisoryOutcome {
  status: CodexAdvisoryOutcomeStatus;
  /** The raw agent_message text -- present only when status === "ok". Caller still has to JSON.parse/validate it against the requested schema. */
  text?: string;
  /** Diagnostic detail for any non-"ok" status, e.g. the turn.failed error payload. */
  detail?: string;
}

/**
 * Drains a codex `--json` event stream and pulls out the final agent
 * message, exactly like `@pros/plan`'s `RealCodexSession.run` does -- except
 * this version reports failure as data (a `CodexAdvisoryOutcome`) rather
 * than throwing, because the advisory reviewer must degrade gracefully
 * (timeout/non-zero exit/malformed output) instead of failing the pipeline.
 */
export async function collectCodexAdvisoryOutcome(events: AsyncIterable<ParsedEvent>): Promise<CodexAdvisoryOutcome> {
  const collected: ParsedEvent[] = [];
  for await (const event of events) collected.push(event);

  const turnFailed = [...collected].reverse().find((e) => e.type === "turn.failed");
  if (turnFailed) {
    const failedData = turnFailed.data as Record<string, unknown> | undefined;
    const failure = failedData?.error ?? failedData?.message ?? failedData?.reason ?? failedData;
    const detail = typeof failure === "string" ? failure : JSON.stringify(failure ?? turnFailed.raw);
    return { status: "turn_failed", detail };
  }

  const messageEvent = [...collected]
    .reverse()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .find((e) => e.type === "item.completed" && (e.data as any)?.item?.type === "agent_message");
  if (!messageEvent || messageEvent.parseStatus !== "ok") {
    return {
      status: "no_agent_message",
      detail: `saw ${collected.length} event(s), last type=${collected[collected.length - 1]?.type ?? "<none>"}`,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = String((messageEvent.data as any).item.text ?? "");
  return { status: "ok", text };
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
