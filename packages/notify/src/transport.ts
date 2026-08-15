/**
 * Transport selection: "ntfy if explicitly configured, else Slack via the
 * connected Slack MCP server." Deliberately tiny -- this is not a plugin
 * system, just the one fallback rule the zero-token-by-default goal needs:
 * `PROS_NTFY_URL` used to be a required setup step; now it's an opt-in
 * alternative, and an unconfigured install still gets real notifications
 * (a Slack DM to the user themselves) rather than a silent no-op.
 */

import { sendNtfy } from "./ntfy.js";
import { sendSlackMcp, type SlackMcpSession } from "./slack-mcp.js";

export interface SendArgs {
  title?: string;
  message: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Shape of a resolved transport -- what wire-barrier.ts actually calls per park. */
export type SendFn = (args: SendArgs) => Promise<SendResult>;

export interface ResolveDefaultSendOptions {
  /** Explicit ntfy URL. If set (or PROS_NTFY_URL is set in `env`), ntfy is used as the transport -- unchanged M3 behavior. */
  url?: string;
  /**
   * Slack channel/user override for the Slack-MCP fallback transport, e.g.
   * from PROS_SLACK_NOTIFY_TARGET. If unset, the fallback DMs the currently
   * authenticated Slack user themselves -- never a shared/public channel by
   * default.
   */
  slackTarget?: string;
  /** Test-only seam: inject a fake session so the Slack-MCP path is exercisable without a real Slack/claude call. */
  slackSession?: SlackMcpSession;
  /** Passed through to sendSlackMcp's bounded timeout. */
  slackTimeoutMs?: number;
  /** Defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Picks the notification transport for a single wireNtfyNotifications
 * subscription: ntfy when a URL is explicitly passed or PROS_NTFY_URL is set
 * in the environment, otherwise Slack-MCP. The returned function is what
 * gets called once per parked checkpoint.
 */
export function resolveDefaultSend(opts: ResolveDefaultSendOptions = {}): SendFn {
  const env = opts.env ?? process.env;
  const url = opts.url ?? env.PROS_NTFY_URL;
  if (url) {
    return (args) => sendNtfy({ url, title: args.title, message: args.message });
  }
  const target = opts.slackTarget ?? env.PROS_SLACK_NOTIFY_TARGET;
  return (args) =>
    sendSlackMcp({
      target,
      title: args.title,
      message: args.message,
      session: opts.slackSession,
      timeoutMs: opts.slackTimeoutMs,
    });
}
