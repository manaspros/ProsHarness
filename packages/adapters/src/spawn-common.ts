// Shared subprocess-spawning plumbing used by both the Claude and Codex
// adapters: spawn with stdin-piped prompt, split stdout into NDJSON lines,
// run each line through a provider-specific parser, optionally tee raw lines
// to a log file for packages/index to tail, and expose an async-iterable
// event stream plus an exitCode promise.

import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { ParsedEvent, Provider, SpawnOptions, SpawnResult } from "./types.js";

export type LineParser = (raw: string, seq: number) => ParsedEvent;

export interface SpawnCliArgs {
  command: string;
  args: string[];
  provider: Provider;
  opts: SpawnOptions;
  parseLine: LineParser;
}

/**
 * Splits a stream of arbitrary chunks into lines (split on \n, tolerating
 * \r\n by trimming a trailing \r). The final partial line (no trailing
 * newline yet) is buffered and only yielded once the stream ends, so we never
 * hand a truncated line to the parser.
 */
async function* splitLines(chunks: AsyncIterable<Buffer>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}

export function spawnCli({ command, args, provider, opts, parseLine }: SpawnCliArgs): SpawnResult {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });

  // Write the prompt to stdin and close it (both CLIs accept a piped prompt
  // with -p / exec, avoiding argv length/escaping issues per the M0 findings).
  child.stdin.write(opts.prompt);
  child.stdin.end();

  // Capture stderr for diagnostics; not part of the parsed event stream, but
  // we don't want it to be silently lost either — surface via a buffered
  // string accessible through the child process's own `stderr` stream if a
  // caller wants it (we don't wrap it further here to keep scope tight).

  let exitCodeResolve!: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => {
    exitCodeResolve = resolve;
  });
  child.on("close", (code) => exitCodeResolve(code));
  child.on("error", () => exitCodeResolve(null));

  const rawLogPath = opts.rawLogPath;
  const attemptId = opts.attemptId;

  async function* events(): AsyncIterable<ParsedEvent> {
    let seq = 0;
    for await (const line of splitLines(child.stdout)) {
      if (line.length === 0) continue; // skip blank keepalive lines, not real events
      if (rawLogPath) {
        // At-least-once append; failures here must never break parsing.
        try {
          await appendFile(rawLogPath, `${attemptId}\t${seq}\t${line}\n`, "utf8");
        } catch {
          // Swallow: the raw log is a best-effort side channel for the index
          // package, not required for correct event delivery.
        }
      }
      const parsed = parseLine(line, seq);
      seq += 1;
      yield parsed;
    }
  }

  return {
    child,
    events: events(),
    exitCode,
  };
}
