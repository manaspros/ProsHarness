/**
 * Real, adapter-backed `ModelSession` implementations. Nothing else in this
 * package imports `@pros/adapters` directly -- see model-session.ts for why.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnClaude, spawnCodex, type ParsedEvent, type SpawnResult } from "@pros/adapters";
import type { ModelRunOptions, ModelRunResult, ModelSession, ModelUsage } from "./model-session.js";

/** Drain an adapter's async-iterable event stream to completion, keeping every event seen. */
async function collectEvents(events: AsyncIterable<ParsedEvent>): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

async function collectEventsAndAwaitLifecycle(spawned: SpawnResult): Promise<ParsedEvent[]> {
  try {
    return await collectEvents(spawned.events);
  } finally {
    // If event delivery fails (for example, a raw-log append fails), do not
    // leave the real CLI behind while the attempt is already failing.
    await Promise.allSettled([spawned.exitCode, spawned.stderr]);
  }
}

async function prepareRawLog(rawLogPath: string | undefined, provider: "claude" | "codex"): Promise<void> {
  if (!rawLogPath) return;
  const attemptDir = path.dirname(rawLogPath);
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "provider.txt"), `${provider}\n`, "utf8");
}

async function persistObservedVersion(rawLogPath: string | undefined, versionSeen: string): Promise<void> {
  const version = versionSeen.trim();
  if (!rawLogPath || !version) return;
  await writeFile(path.join(path.dirname(rawLogPath), "cli_version.txt"), `${version}\n`, "utf8");
}

/**
 * Codex's `--output-schema` uses strict structured-output validation. OpenAI's
 * strict schema dialect requires every object to reject undeclared keys and
 * every declared property to be required. The Claude-facing schemas in this
 * repository intentionally omit those keywords, so normalize a deep copy at
 * the Codex boundary instead of forcing every shared schema to carry
 * provider-specific details.
 */
export function toCodexStrictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCodexStrictSchema);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...source };

  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const sourceProperties = source.properties as Record<string, unknown>;
    copy.properties = Object.fromEntries(
      Object.entries(sourceProperties).map(([key, property]) => [key, toCodexStrictSchema(property)]),
    );
    copy.required = Object.keys(sourceProperties);
    copy.additionalProperties = false;
  } else if (source.type === "object") {
    copy.additionalProperties = false;
  }

  for (const key of ["items", "contains", "not", "if", "then", "else", "propertyNames"]) {
    if (key in copy) copy[key] = toCodexStrictSchema(copy[key]);
  }
  for (const key of ["anyOf", "allOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].map(toCodexStrictSchema);
  }

  return copy;
}

export class RealClaudeSession implements ModelSession {
  readonly provider = "claude" as const;

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const extraArgs: string[] = [];
    if (opts.schema) extraArgs.push("--json-schema", JSON.stringify(opts.schema));
    await prepareRawLog(opts.rawLogPath, "claude");

    const spawned = spawnClaude({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      // All dashboard/CLI Claude sessions are unattended. Keep this policy
      // at the real-session boundary so newly-added callers cannot
      // accidentally reintroduce an approval prompt that stalls a run.
      dangerouslySkipPermissions: true,
      timeoutMs: opts.timeoutMs,
      extraArgs,
      rawLogPath: opts.rawLogPath,
      attemptId: opts.attemptId,
    });

    try {
      const collected = await collectEventsAndAwaitLifecycle(spawned);
      const [exitCodeValue, stderrText] = await Promise.all([spawned.exitCode, spawned.stderr]);

      if (exitCodeValue !== 0) {
        throw new Error(
          `RealClaudeSession: Claude CLI exited unsuccessfully (attemptId=${opts.attemptId}, exitCode=${exitCodeValue ?? "unknown"})` +
            (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
        );
      }

      // The terminal event for a Claude `-p` run is `type: "result"`; its
      // `result` field carries the final assistant text (schema-constrained
      // JSON when `--json-schema` was given), `session_id` is the resumable
      // session id, and `usage` carries token counts -- field names confirmed
      // against packages/adapters/test/fixtures/claude/claude-pong.ndjson.
      const resultEvent = [...collected].reverse().find((e) => e.type === "result");
      if (!resultEvent || resultEvent.parseStatus !== "ok" || !resultEvent.data) {
        throw new Error(
          `RealClaudeSession: no terminal "result" event found in claude output (attemptId=${opts.attemptId}); ` +
            `exitCode=${exitCodeValue ?? "unknown"}; saw ${collected.length} events, ` +
            `last type=${collected[collected.length - 1]?.type ?? "<none>"}` +
            (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
        );
      }
      const data = resultEvent.data as Record<string, unknown>;
      if (data.is_error === true) {
        const reason = typeof data.result === "string" && data.result.trim() ? data.result.trim() : JSON.stringify(data);
        throw new Error(`RealClaudeSession: Claude reported a failed turn (attemptId=${opts.attemptId}): ${reason}`);
      }
      const usageRaw = (data.usage as Record<string, unknown> | undefined) ?? {};
      const usage: ModelUsage = {
        inputTokens: Number(usageRaw.input_tokens ?? 0),
        outputTokens: Number(usageRaw.output_tokens ?? 0),
      };
      return {
        text: String(data.result ?? ""),
        sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
        usage,
      };
    } finally {
      const observedVersion = (await spawned.versionSeen?.catch(() => "")) ?? "";
      await persistObservedVersion(opts.rawLogPath, observedVersion);
    }
  }
}

export class RealCodexSession implements ModelSession {
  readonly provider = "codex" as const;

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const extraArgs: string[] = [];
    let schemaTmpDir: string | undefined;
    if (opts.schema) {
      // Codex's --output-schema wants a real file path, not inline JSON.
      schemaTmpDir = await mkdtemp(path.join(tmpdir(), "pros-codex-schema-"));
      const schemaPath = path.join(schemaTmpDir, "schema.json");
      await writeFile(schemaPath, JSON.stringify(toCodexStrictSchema(opts.schema)));
      extraArgs.push("--output-schema", schemaPath);
    }

    try {
      await prepareRawLog(opts.rawLogPath, "codex");
      const spawned = spawnCodex({
        cwd: opts.cwd,
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        // Automated Codex assessment/review is also unattended. This keeps
        // it from failing solely because it cannot ask the user for approval.
        dangerouslySkipPermissions: true,
        timeoutMs: opts.timeoutMs,
        extraArgs,
        rawLogPath: opts.rawLogPath,
        attemptId: opts.attemptId,
      });

      try {
        const collected = await collectEventsAndAwaitLifecycle(spawned);
        const [exitCodeValue, stderrText] = await Promise.all([spawned.exitCode, spawned.stderr]);

        if (exitCodeValue !== 0) {
          throw new Error(
            `RealCodexSession: Codex CLI exited unsuccessfully (attemptId=${opts.attemptId}, exitCode=${exitCodeValue ?? "unknown"})` +
              (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
          );
        }

        // The final agent text arrives in an `item.completed` event whose
        // `item.type === "agent_message"`; usage arrives separately in the
        // terminal `turn.completed` event. Confirmed against
        // packages/adapters/test/fixtures/codex/codex-pong.ndjson.
        const messageEvent = [...collected]
          .reverse()
          .find((e) => e.type === "item.completed" && (e.data as any)?.item?.type === "agent_message");
        const turnCompleted = [...collected].reverse().find((e) => e.type === "turn.completed");
        const turnFailed = [...collected].reverse().find((e) => e.type === "turn.failed");

        if (turnFailed) {
          const failedData = turnFailed.data as Record<string, unknown> | undefined;
          const failure = failedData?.error ?? failedData?.message ?? failedData?.reason ?? failedData;
          const detail = typeof failure === "string" ? failure : JSON.stringify(failure ?? turnFailed.raw);
          throw new Error(
            `RealCodexSession: Codex turn failed (attemptId=${opts.attemptId}, exitCode=${exitCodeValue ?? "unknown"}): ` +
              `${detail}` +
              (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
          );
        }

        if (!messageEvent || messageEvent.parseStatus !== "ok") {
          throw new Error(
            `RealCodexSession: no "item.completed" agent_message event found in codex output (attemptId=${opts.attemptId}); ` +
              `exitCode=${exitCodeValue ?? "unknown"}; saw ${collected.length} events, ` +
              `last type=${collected[collected.length - 1]?.type ?? "<none>"}` +
              (stderrText.trim() ? `; stderr: ${stderrText.trim()}` : ""),
          );
        }
        const text = String((messageEvent.data as any).item.text ?? "");

        let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
        let threadId: string | undefined;
        if (turnCompleted?.parseStatus === "ok") {
          const usageRaw = (turnCompleted.data as any).usage ?? {};
          usage = {
            inputTokens: Number(usageRaw.input_tokens ?? 0),
            outputTokens: Number(usageRaw.output_tokens ?? 0),
          };
        }
        const threadStarted = collected.find((e) => e.type === "thread.started");
        if (threadStarted?.parseStatus === "ok") {
          threadId = (threadStarted.data as any).thread_id;
        }

        return { text, sessionId: threadId, usage };
      } finally {
        const observedVersion = (await spawned.versionSeen?.catch(() => "")) ?? "";
        await persistObservedVersion(opts.rawLogPath, observedVersion);
      }
    } finally {
      if (schemaTmpDir) await rm(schemaTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Convenience for callers that just want a random per-call attempt id. */
export function newAttemptId(): string {
  return randomUUID();
}
