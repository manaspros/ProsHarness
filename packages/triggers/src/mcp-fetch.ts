/**
 * Shared MCP-query helper for the read-only trigger sources (linear.ts,
 * slack.ts, granola.ts).
 *
 * Design (see the project's credential-simplification rework, MCP-first
 * ambient triggers): each source already has, via the user's Claude Code
 * environment, an OAuth-authenticated MCP server connected for its service
 * (Linear/Slack/Granola) -- no new API key needed. `packages/adapters`
 * already spawns the real `claude` CLI as a subprocess (never the raw
 * Anthropic API), so driving a short-lived `claude -p` invocation that uses
 * those already-connected MCP tools spends the Claude subscription, not API
 * billing, and needs zero new credentials.
 *
 * Like everywhere else in this codebase (see packages/plan/src/finding.ts),
 * the actual model driver is injected as a `ModelSession` -- tests inject a
 * fake, only the real `buildSources()` wiring constructs a real
 * `RealClaudeSession()`, and only lazily, so importing this module never
 * requires a real `claude` binary to exist.
 *
 * These MCP servers are interactively-authenticated and can genuinely be
 * absent when an unattended daemon fires from cron. So this helper is
 * bounded by an explicit timeout and never swallows a failure -- it always
 * rejects with a clear, specific error on timeout/malformed output, letting
 * each source's caller decide whether to fall back to an API-key path or
 * throw (never silently return `[]`, which would defeat observability).
 */

import type { ModelSession } from "@pros/plan";

export interface RunMcpQueryOptions {
  session: ModelSession;
  prompt: string;
  schema: object;
  timeoutMs: number;
  /** Used only in the timeout error message, to identify which source/call timed out. */
  label: string;
}

class McpTimeoutError extends Error {}

/**
 * Runs one schema-constrained `ModelSession.run()` call, racing it against
 * `timeoutMs`. Resolves with the parsed JSON value (caller does its own
 * shape validation/mapping -- this helper only owns the timeout + JSON
 * parse, not per-source fixture shape checks). Rejects with a clear error
 * on timeout, on a session throw, or on non-JSON output.
 */
export async function runMcpQuery<T>(opts: RunMcpQueryOptions): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new McpTimeoutError(`${opts.label}: MCP query timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });

  const run = opts.session.run({
    cwd: process.cwd(),
    prompt: opts.prompt,
    schema: opts.schema,
    attemptId: `mcp-${opts.label}-${Date.now()}`,
  });

  const result = await Promise.race([run, timeout]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch (err: any) {
    throw new Error(`${opts.label}: MCP query returned non-JSON output: ${err?.message ?? err}`);
  }
  return parsed as T;
}
