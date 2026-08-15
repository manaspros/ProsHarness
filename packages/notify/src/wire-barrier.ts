import { resolveDefaultSend, type SendFn } from "./transport.js";
import type { SlackMcpSession } from "./slack-mcp.js";

/**
 * Mirrors the info payload `Barrier.onParked` fires with (see
 * packages/barrier/src/barrier.ts's `ParkedListener` type). Duplicated here
 * rather than imported so that @pros/notify has ZERO dependency on
 * @pros/barrier -- it stays a leaf package, trivially unit-testable against
 * a structural fake, and never needs to be rebuilt in lockstep with barrier
 * internals.
 */
export interface ParkedNotificationInfo {
  runId: string;
  checkpointId: string;
  questionId: string;
  gateType: "ask_human" | "plan_approval" | "pr_review";
  prompt: string;
  planRef?: { planId: string; version: number };
  /** Present only when gateType is "pr_review" (M4 Gate 2). */
  prRef?: { url: string; number: number; headSha: string };
}

/**
 * Structural type matching Barrier.onParked's signature -- avoids an
 * @pros/barrier dependency entirely. Any object with an `onParked` method
 * shaped like this (the real Barrier, a test fake, a future alternative
 * implementation) can be wired up.
 */
export interface ParkedNotifierSource {
  onParked(cb: (info: ParkedNotificationInfo) => void): () => void;
}

export interface WireNtfyOptions {
  /** ntfy URL. If set (or PROS_NTFY_URL is set in the environment), ntfy is used as the transport -- unchanged since M3. */
  url?: string;
  /**
   * Slack channel/user override, used only when ntfy is NOT configured
   * (i.e. the Slack-MCP fallback transport is in effect). If unset, the
   * fallback DMs the currently authenticated Slack user themselves --
   * never a shared/public channel by default. See PROS_SLACK_NOTIFY_TARGET.
   */
  slackTarget?: string;
  /** Test-only seam: inject a fake Slack session so tests exercise the Slack-MCP fallback path without a real Slack/claude call. */
  slackSession?: SlackMcpSession;
  /** Bounded timeout passed through to the Slack-MCP fallback transport. */
  slackTimeoutMs?: number;
  /**
   * Full transport override -- if set, bypasses url/slack* resolution
   * entirely and this exact function is called for every park. Primarily
   * for tests; production callers should prefer `url`/`slackTarget`.
   */
  send?: SendFn;
  /** Defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Called with each send result, for logging/testing -- optional, never required. */
  onResult?: (info: ParkedNotificationInfo, result: { ok: boolean; error?: string }) => void;
}

/**
 * Subscribes to a Barrier-like source's onParked hook and fires a
 * notification push for every parked checkpoint (both ask_human
 * "Questions" and submit_plan "Gate 1 plan approval" parks get a
 * human-readable notification). The transport is resolved once, via
 * `resolveDefaultSend` (see transport.ts): ntfy when `url`/PROS_NTFY_URL is
 * configured (unchanged since M3), otherwise Slack via the connected Slack
 * MCP server -- PROS_NTFY_URL is no longer a required setup step. Returns
 * an unsubscribe function, mirroring onParked's own contract.
 *
 * Critical property, proven by the tests in test/wire-barrier.test.ts: no
 * matter what the resolved transport does (succeeds, fails, times out), it
 * NEVER becomes something the caller of onParked's underlying park
 * sequence has to wait on or handle. This function's callback body
 * dispatches an async operation it does NOT await into the park sequence
 * -- Barrier.onParked already fires listeners via a microtask + try/catch,
 * so this function does not need to duplicate that defense, but it must
 * still never let a rejected promise become unhandled (hence the
 * unconditional `.catch` below, belt-and-braces on top of both transports'
 * own promise-that-never-rejects contract).
 */
export function wireNtfyNotifications(source: ParkedNotifierSource, opts: WireNtfyOptions = {}): () => void {
  const send =
    opts.send ??
    resolveDefaultSend({
      url: opts.url,
      slackTarget: opts.slackTarget,
      slackSession: opts.slackSession,
      slackTimeoutMs: opts.slackTimeoutMs,
      env: opts.env,
    });
  return source.onParked((info) => {
    const message = buildMessage(info);
    send({ title: gateTitle(info), message })
      .then((result) => opts.onResult?.(info, result))
      .catch(() => undefined); // belt-and-braces -- neither transport should ever throw, but never trust that from the calling side either
  });
}

function gateTitle(info: ParkedNotificationInfo): string {
  if (info.gateType === "plan_approval") return "ProsHarness: plan awaiting Gate 1 approval";
  if (info.gateType === "pr_review") return "ProsHarness: draft PR awaiting Gate 2 review";
  return "ProsHarness: question awaiting your answer";
}

const MAX_PROMPT_LEN = 200;

/**
 * Human-readable one-liner for a phone lock screen: run id, and either the
 * plan ref (plan_approval) or the truncated question prompt (ask_human).
 */
function buildMessage(info: ParkedNotificationInfo): string {
  const shortRun = info.runId.slice(0, 12);
  if (info.gateType === "plan_approval" && info.planRef) {
    return `Run ${shortRun}: plan ${info.planRef.planId} v${info.planRef.version} is awaiting Gate 1 approval.`;
  }
  if (info.gateType === "pr_review" && info.prRef) {
    return `Run ${shortRun}: draft PR #${info.prRef.number} (${info.prRef.url}) is awaiting Gate 2 review.`;
  }
  const prompt =
    info.prompt.length > MAX_PROMPT_LEN ? info.prompt.slice(0, MAX_PROMPT_LEN) + "…" : info.prompt;
  return `Run ${shortRun}: ${prompt}`;
}
