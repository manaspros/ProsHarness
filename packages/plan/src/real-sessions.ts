/**
 * Real, adapter-backed `ModelSession` implementations. Nothing else in this
 * package imports `@pros/adapters` directly -- see model-session.ts for why.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnClaude, spawnCodex, type ParsedEvent } from "@pros/adapters";
import type { ModelRunOptions, ModelRunResult, ModelSession, ModelUsage } from "./model-session.js";

/** Drain an adapter's async-iterable event stream to completion, keeping every event seen. */
async function collectEvents(events: AsyncIterable<ParsedEvent>): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

export class RealClaudeSession implements ModelSession {
  readonly provider = "claude" as const;

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    const extraArgs: string[] = [];
    if (opts.schema) extraArgs.push("--json-schema", JSON.stringify(opts.schema));

    const { events, exitCode } = spawnClaude({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      extraArgs,
      rawLogPath: opts.rawLogPath,
      attemptId: opts.attemptId,
    });

    const collected = await collectEvents(events);
    await exitCode;

    // The terminal event for a Claude `-p` run is `type: "result"`; its
    // `result` field carries the final assistant text (schema-constrained
    // JSON when `--json-schema` was given), `session_id` is the resumable
    // session id, and `usage` carries token counts -- field names confirmed
    // against packages/adapters/test/fixtures/claude/claude-pong.ndjson.
    const resultEvent = [...collected].reverse().find((e) => e.type === "result");
    if (!resultEvent || resultEvent.parseStatus !== "ok" || !resultEvent.data) {
      throw new Error(
        `RealClaudeSession: no terminal "result" event found in claude output (attemptId=${opts.attemptId}); ` +
          `saw ${collected.length} events, last type=${collected[collected.length - 1]?.type ?? "<none>"}`,
      );
    }
    const data = resultEvent.data as Record<string, unknown>;
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
      await writeFile(schemaPath, JSON.stringify(opts.schema));
      extraArgs.push("--output-schema", schemaPath);
    }

    try {
      const { events, exitCode } = spawnCodex({
        cwd: opts.cwd,
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        extraArgs,
        rawLogPath: opts.rawLogPath,
        attemptId: opts.attemptId,
      });

      const collected = await collectEvents(events);
      await exitCode;

      // The final agent text arrives in an `item.completed` event whose
      // `item.type === "agent_message"`; usage arrives separately in the
      // terminal `turn.completed` event. Confirmed against
      // packages/adapters/test/fixtures/codex/codex-pong.ndjson.
      const messageEvent = [...collected]
        .reverse()
        .find((e) => e.type === "item.completed" && (e.data as any)?.item?.type === "agent_message");
      const turnCompleted = [...collected].reverse().find((e) => e.type === "turn.completed");

      if (!messageEvent || messageEvent.parseStatus !== "ok") {
        throw new Error(
          `RealCodexSession: no "item.completed" agent_message event found in codex output (attemptId=${opts.attemptId}); ` +
            `saw ${collected.length} events, last type=${collected[collected.length - 1]?.type ?? "<none>"}`,
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
      if (schemaTmpDir) await rm(schemaTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Convenience for callers that just want a random per-call attempt id. */
export function newAttemptId(): string {
  return randomUUID();
}
