// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Slack. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic. This includes the MCP path below: the prompt handed to
// the model explicitly instructs read-only tool use (list/search/fetch
// channel history) and never instructs it to send, react to, or otherwise
// write anything in Slack.

import { readFile } from "node:fs/promises";
import type { ModelSession } from "@pros/plan";
import { RealClaudeSession } from "@pros/plan";
import type { Signal, TriggerSource } from "../types.js";
import { runMcpQuery } from "../mcp-fetch.js";

export interface SlackMessageFixture {
  ts: string;
  channel: string;
  user: string;
  text: string;
  permalink?: string;
}

const SLACK_MESSAGE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      ts: { type: "string" },
      channel: { type: "string" },
      user: { type: "string" },
      text: { type: "string" },
      permalink: { type: "string" },
    },
    required: ["ts", "channel", "user", "text"],
  },
} as const;

export interface SlackSourceOptions {
  /** Path to a JSON fixture -- an array of SlackMessageFixture. Used for tests and offline/local dev. */
  fixturePath?: string;
  /** Real Slack bot token. Only used if both botToken and channel are set. */
  botToken?: string;
  channel?: string;
  /**
   * Injected model driver for the MCP path -- see mcp-fetch.ts's doc
   * comment. Defaults to a real `RealClaudeSession()`, lazily constructed
   * only when the MCP path is actually attempted, so importing/using this
   * module with a fixturePath or in tests never requires a real `claude`
   * binary.
   */
  mcpSession?: ModelSession;
  /** Timeout for the MCP path before falling back / throwing. Default 20000ms. */
  mcpTimeoutMs?: number;
}

export class SlackSource implements TriggerSource {
  readonly id = "slack";

  constructor(private readonly opts: SlackSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }

    try {
      return await this.fetchFromMcp();
    } catch (mcpErr: any) {
      if (this.opts.botToken && this.opts.channel) {
        return this.fetchFromApi(this.opts.botToken, this.opts.channel);
      }
      // No headless fallback configured -- observable failure (see
      // runner.ts's sourceFailures), never a silent [].
      throw new Error(
        `SlackSource: MCP path unavailable (Slack MCP server not connected, or timed out) and no PROS_SLACK_BOT_TOKEN fallback configured: ${mcpErr?.message ?? mcpErr}`,
      );
    }
  }

  private async fetchFromFixture(fixturePath: string): Promise<Signal[]> {
    let raw: string;
    try {
      raw = await readFile(fixturePath, "utf8");
    } catch (err: any) {
      throw new Error(`SlackSource: could not read fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    let messages: SlackMessageFixture[];
    try {
      messages = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`SlackSource: malformed JSON fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    if (!Array.isArray(messages)) {
      throw new Error(`SlackSource: fixture at ${fixturePath} must be a JSON array of messages`);
    }
    return messages.map((msg) => this.toSignal(msg));
  }

  private toSignal(msg: SlackMessageFixture): Signal {
    return {
      sourceId: this.id,
      externalId: msg.ts,
      kind: "message",
      title: `#${msg.channel} message from ${msg.user}`,
      body: msg.text,
      url: msg.permalink,
      raisedAt: new Date(Number(msg.ts) * 1000).toISOString(),
    };
  }

  /**
   * MCP-first path: asks an already-connected Claude session to use its
   * Slack MCP server's READ-ONLY tools (list channels / fetch channel
   * history -- never send a message, react, or otherwise write) and
   * respond with ONLY JSON matching SlackMessageFixture[]. Bounded by
   * mcpTimeoutMs.
   */
  private async fetchFromMcp(): Promise<Signal[]> {
    const session = this.opts.mcpSession ?? new RealClaudeSession();
    const prompt = [
      "Use your already-connected Slack MCP server's READ-ONLY tools",
      "(list channels / fetch channel history -- never send a message,",
      "react, or otherwise write to Slack) to retrieve up to 50 recent",
      "messages from channels relevant to the current user.",
      "",
      "Respond with ONLY a JSON array (matching the provided schema) of",
      "objects shaped like:",
      '  { "ts": string, "channel": string, "user": string, "text": string,',
      '    "permalink"?: string }',
      "No prose, no markdown fences -- just the JSON array. An empty array",
      "is a valid response if there are no relevant messages.",
    ].join("\n");

    const messages = await runMcpQuery<SlackMessageFixture[]>({
      session,
      prompt,
      schema: SLACK_MESSAGE_SCHEMA,
      timeoutMs: this.opts.mcpTimeoutMs ?? 20_000,
      label: "SlackSource",
    });
    if (!Array.isArray(messages)) {
      throw new Error("SlackSource: MCP query returned non-array JSON");
    }
    return messages.map((msg) => this.toSignal(msg));
  }

  /**
   * Real Slack conversations.history fetch (read-only). NOT exercised
   * against the network by any test in this package -- deliberately
   * untested, for future real-account wiring only. Documented
   * headless-reliability fallback when the MCP path is unavailable.
   */
  private async fetchFromApi(botToken: string, channel: string): Promise<Signal[]> {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=50`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
    if (!res.ok) {
      throw new Error(`SlackSource: Slack API request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; messages?: Array<{ ts: string; user: string; text: string }> };
    if (!json.ok) {
      throw new Error("SlackSource: Slack API returned ok=false");
    }
    const messages = json.messages ?? [];
    return messages.map((m) => this.toSignal({ ts: m.ts, channel, user: m.user, text: m.text }));
  }
}
