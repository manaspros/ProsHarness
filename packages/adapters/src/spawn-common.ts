// Shared subprocess-spawning plumbing used by both the Claude and Codex
// adapters: spawn with stdin-piped prompt, split stdout into NDJSON lines,
// run each line through a provider-specific parser, optionally tee raw lines
// to a log file for packages/index to tail, and expose an async-iterable
// event stream plus an exitCode promise.
//
// This is also the ONE shared place that strips GitHub credentials before a
// model/agent subprocess is spawned -- see `stripGhCredentials` below.

import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * Model/agent subprocesses (Sonnet's `scoped-fixer`, Codex, `claude
 * ultrareview` -- everything routed through `spawnClaude`/`spawnCodex`, which
 * both call this function) must NEVER be able to act as a GitHub-authenticated
 * `gh` caller. That boundary is enforced here, in the ONE place both adapters
 * share, rather than in each adapter separately, so it cannot be forgotten by
 * a future third provider:
 *
 *   - `GH_TOKEN`/`GITHUB_TOKEN` are unconditionally deleted from the child's
 *     env, even if the orchestrator's OWN process (or the caller's `opts.env`)
 *     happens to have one set -- e.g. an operator's ambient shell exporting
 *     `GH_TOKEN` for unrelated reasons must not leak into a model subprocess.
 *   - `GH_CONFIG_DIR` is repointed at a fresh, never-created scratch path, so
 *     that if the model's own Bash tool shells out to `gh` directly, `gh`
 *     finds no ambient `gh auth login` session there either (a missing/empty
 *     config dir reads to `gh` as "not logged in"). We deliberately do NOT
 *     create this directory -- there is nothing for `gh` to find in it either
 *     way, and not creating it is one fewer filesystem side effect per spawn.
 *
 * This is unconditional and applies to every session type (finding, debate,
 * critique, implement, verify, review) -- no model subprocess is ever the
 * right place for real `gh` credentials; only the deterministic orchestrator
 * itself (`packages/implement/src/pipeline.ts`) is.
 */
function stripGhCredentials(env: NodeJS.ProcessEnv): void {
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env.GH_CONFIG_DIR = path.join(tmpdir(), `pros-no-gh-config-${randomUUID()}`);
}

export function spawnCli({ command, args, provider, opts, parseLine }: SpawnCliArgs): SpawnResult {
  const env = { ...process.env, ...opts.env };
  stripGhCredentials(env);

  const child = spawn(command, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  // Write the prompt to stdin and close it (both CLIs accept a piped prompt
  // with -p / exec, avoiding argv length/escaping issues per the M0 findings).
  child.stdin.write(opts.prompt);
  child.stdin.end();

  // Capture stderr for diagnostics; not part of the parsed event stream, but
  // keep it buffered so a failed unattended turn can report the CLI's actual
  // reason instead of collapsing into a generic "no final message" error.
  let stderrText = "";
  let stderrFinished = false;
  let finishStderr!: () => void;
  const stderr = new Promise<string>((resolve) => {
    finishStderr = () => {
      if (stderrFinished) return;
      stderrFinished = true;
      resolve(stderrText);
    };
  });
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr.once("end", finishStderr);
    child.stderr.once("error", finishStderr);
  } else {
    finishStderr();
  }

  let exitCodeResolve!: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => {
    exitCodeResolve = resolve;
  });
  let closed = false;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (error: Error) => void;
  const timeoutSignal =
    opts.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          rejectTimeout = reject;
        });
  // The timeout signal is also created when a caller only uses the lifecycle
  // promises and never consumes `events`. Mark its rejection handled here so
  // a timed-out, abandoned stream cannot become an unhandled rejection.
  timeoutSignal?.catch(() => undefined);
  const clearKillTimers = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (forceKillHandle) clearTimeout(forceKillHandle);
    timeoutHandle = undefined;
    forceKillHandle = undefined;
  };
  const terminate = (signal: NodeJS.Signals, closeStreams: boolean): void => {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited between the state check and kill.
    }
    if (closeStreams) {
      child.stdout.destroy();
      child.stderr?.destroy();
    }
  };
  const scheduleForceKill = (): void => {
    if (forceKillHandle) clearTimeout(forceKillHandle);
    forceKillHandle = setTimeout(() => {
      if (!closed) terminate("SIGKILL", true);
    }, 1_000);
  };
  child.on("close", (code) => {
    closed = true;
    clearKillTimers();
    exitCodeResolve(code);
    finishStderr();
  });
  child.on("error", () => {
    closed = true;
    clearKillTimers();
    exitCodeResolve(null);
    finishStderr();
  });

  if (opts.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      if (closed) return;
      timedOut = true;
      const timeoutError = new Error(`spawnCli: CLI attempt ${attemptId} timed out after ${opts.timeoutMs}ms`);
      rejectTimeout(timeoutError);
      terminate("SIGTERM", true);
      // A CLI that ignores SIGTERM must not leave an acceptance/test process
      // alive forever. The normal path is still graceful SIGTERM first.
      scheduleForceKill();
    }, Math.max(0, opts.timeoutMs));
  }

  const rawLogPath = opts.rawLogPath;
  const attemptId = opts.attemptId;

  async function* events(): AsyncIterable<ParsedEvent> {
    let seq = 0;
    const source = splitLines(child.stdout)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = timeoutSignal ? await Promise.race([source.next(), timeoutSignal]) : await source.next();
        if (next.done) break;
        const line = next.value;
        if (line.length === 0) continue; // skip blank keepalive lines, not real events
        if (rawLogPath) {
          try {
            // The attempt directory already carries attemptId and the line
            // order is the raw file's seq. Keep the file itself as verbatim
            // provider NDJSON so it can be tailed and parsed by the dashboard.
            await appendFile(rawLogPath, `${line}\n`, "utf8");
          } catch (error) {
            // A missing/unwritable raw log means the attempt cannot satisfy
            // its audit contract. Stop the child and fail the stream instead
            // of continuing with a deceptively successful model result.
            terminate("SIGTERM", true);
            scheduleForceKill();
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`spawnCli: failed to write raw log ${rawLogPath} for attempt ${attemptId}: ${reason}`);
          }
        }
        const parsed = parseLine(line, seq);
        seq += 1;
        yield parsed;
      }
    } finally {
      await source.return?.();
    }
    if (timedOut) {
      throw new Error(`spawnCli: CLI attempt ${attemptId} timed out after ${opts.timeoutMs}ms`);
    }
  }

  return {
    child,
    events: events(),
    exitCode,
    stderr,
  };
}
