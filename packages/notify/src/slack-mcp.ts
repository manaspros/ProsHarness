/**
 * Slack push-notification transport, delivered via a short-lived `claude -p`
 * subprocess that drives the user's already-connected Slack MCP server (see
 * docs/00-decisions.md's rationale for spawning the real `claude` CLI
 * elsewhere in this repo: it carries the user's OAuth-connected MCP servers
 * and spends the Claude subscription rather than API billing, so a Slack DM
 * needs zero new credentials beyond what's already configured).
 *
 * This is the default notification transport (see transport.ts):
 * `PROS_NTFY_URL` is no longer a required setup step, and most users will
 * never configure ntfy at all. This module exists so "no ntfy configured"
 * still results in a real notification landing somewhere the user will see
 * it, instead of the previous silent no-op.
 *
 * Same non-negotiable contract as sendNtfy (see ntfy.ts's doc comment):
 * `sendSlackMcp` NEVER throws and NEVER hangs past `timeoutMs`. Every
 * failure mode -- MCP server unavailable/disconnected, the `claude`
 * subprocess failing to start or exiting non-zero, a malformed/missing
 * result event, or simply taking too long -- is caught and turned into a
 * plain `{ ok: false, error }` value. Callers (wire-barrier.ts's
 * fire-and-forget onParked listener) depend on this exactly as strictly as
 * they depend on sendNtfy's equivalent promise.
 *
 * Safety: by default (no `target` given) the prompt instructs the model to
 * send a Slack DM to the currently authenticated user themselves -- the
 * most private possible destination, requiring no channel name and never
 * touching a shared/public channel. A `target` may be passed (or read from
 * `PROS_SLACK_NOTIFY_TARGET` by the transport-selection layer in
 * transport.ts) to redirect to a specific channel/user the operator
 * explicitly configured. This module never invents or guesses a channel.
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "@pros/adapters";
import type { ParsedEvent } from "@pros/adapters";

/**
 * Structural type for the thing that actually drives a model turn --
 * intentionally shaped like (but NOT imported from) @pros/plan's
 * `ModelSession`. Duplicated here for the same reason wire-barrier.ts
 * duplicates `ParkedNotificationInfo` rather than importing it from
 * @pros/barrier: it keeps @pros/notify a leaf package with zero heavy
 * @pros/* runtime deps of its own beyond @pros/adapters (itself a leaf, zero
 * @pros/* deps), trivially unit-testable against a structural fake, and
 * never needs to be rebuilt in lockstep with @pros/plan internals.
 */
export interface SlackMcpSession {
  run(opts: { prompt: string; cwd: string; attemptId: string }): Promise<{ text: string }>;
}

/**
 * Real, `claude -p`-subprocess-backed default session. Drains the NDJSON
 * event stream the same way @pros/plan's RealClaudeSession does (see that
 * file's doc comment) and returns the terminal `result` event's text --
 * duplicated rather than imported for the same leaf-package reasoning as
 * `SlackMcpSession` above.
 */
class RealClaudeMcpSession implements SlackMcpSession {
  async run(opts: { prompt: string; cwd: string; attemptId: string }): Promise<{ text: string }> {
    const { events, exitCode } = spawnClaude({
      cwd: opts.cwd,
      prompt: opts.prompt,
      dangerouslySkipPermissions: true,
      attemptId: opts.attemptId,
    });

    const collected: ParsedEvent[] = [];
    for await (const ev of events) collected.push(ev);
    await exitCode;

    const resultEvent = [...collected].reverse().find((e) => e.type === "result");
    if (!resultEvent || resultEvent.parseStatus !== "ok" || !resultEvent.data) {
      throw new Error(
        `sendSlackMcp: no terminal "result" event found in claude output (attemptId=${opts.attemptId}); ` +
          `saw ${collected.length} events, last type=${collected[collected.length - 1]?.type ?? "<none>"}`,
      );
    }
    const data = resultEvent.data as Record<string, unknown>;
    return { text: String(data.result ?? "") };
  }
}

// Lazily constructed so importing this module never spawns anything, and so
// tests that always inject their own `session` never touch this at all.
let defaultSession: SlackMcpSession | undefined;
function getDefaultSession(): SlackMcpSession {
  if (!defaultSession) defaultSession = new RealClaudeMcpSession();
  return defaultSession;
}

export interface SendSlackMcpOptions {
  message: string;
  title?: string;
  /**
   * Channel/user override, e.g. a Slack channel name or user id the
   * operator explicitly configured (see PROS_SLACK_NOTIFY_TARGET in
   * transport.ts). If omitted, the prompt tells the model to DM the
   * currently authenticated Slack user -- never a shared/public channel by
   * default.
   */
  target?: string;
  /** Injectable for tests -- never construct a real session in a test. */
  session?: SlackMcpSession;
  /** Abort/give up if the send takes longer than this. Default 20000ms -- notifications must never be allowed to hang a caller indefinitely. */
  timeoutMs?: number;
  /** cwd for the underlying claude subprocess. Defaults to process.cwd() -- this send has no repo dependency, so any valid directory works. */
  cwd?: string;
}

export interface SendSlackMcpResult {
  ok: boolean;
  error?: string;
}

/**
 * Drives the user's connected Slack MCP server (via a short-lived `claude
 * -p` call) to send exactly one Slack message. NEVER throws -- every
 * failure mode (MCP unavailable, subprocess failure, malformed output,
 * timeout) is caught and returned as { ok: false, error }. Bounded by
 * `timeoutMs` (default 20000ms): if the underlying session hasn't resolved
 * by then, this resolves { ok: false, error } regardless of what the
 * subprocess is still doing.
 */
export async function sendSlackMcp(opts: SendSlackMcpOptions): Promise<SendSlackMcpResult> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = opts.session ?? getDefaultSession();
    const prompt = buildPrompt(opts);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sendSlackMcp: timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([
      session.run({ prompt, cwd: opts.cwd ?? process.cwd(), attemptId: randomUUID() }),
      timeout,
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a prompt that instructs the model to perform exactly one action --
 * send this one message via its connected Slack MCP tool to the given
 * target, or to the user's own DM if none is given -- and nothing else
 * (read-only elsewhere, no browsing/searching, no extra messages).
 */
function buildPrompt(opts: SendSlackMcpOptions): string {
  const destination = opts.target
    ? `to the Slack channel/user "${opts.target}"`
    : "as a direct message to yourself (the currently authenticated Slack user) -- do NOT post it to any channel";
  const body = opts.title ? `${opts.title}\n\n${opts.message}` : opts.message;
  return [
    "You have access to a connected Slack MCP tool.",
    `Use it to send exactly ONE Slack message ${destination}.`,
    "The message text must be exactly the following, verbatim:",
    "---",
    body,
    "---",
    "Do not take any other action: no browsing, no searching, no reading other channels or messages, no additional messages. Send only this single message, then stop.",
  ].join("\n\n");
}
