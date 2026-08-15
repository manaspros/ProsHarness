// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Slack. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic.

import { readFile } from "node:fs/promises";
import type { Signal, TriggerSource } from "../types.js";

export interface SlackMessageFixture {
  ts: string;
  channel: string;
  user: string;
  text: string;
  permalink?: string;
}

export interface SlackSourceOptions {
  /** Path to a JSON fixture -- an array of SlackMessageFixture. Used for tests and offline/local dev. */
  fixturePath?: string;
  /** Real Slack bot token. Only used if both botToken and channel are set. */
  botToken?: string;
  channel?: string;
}

export class SlackSource implements TriggerSource {
  readonly id = "slack";

  constructor(private readonly opts: SlackSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }
    if (this.opts.botToken && this.opts.channel) {
      return this.fetchFromApi(this.opts.botToken, this.opts.channel);
    }
    // Not configured -- degrade gracefully.
    return [];
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
   * Real Slack conversations.history fetch (read-only). NOT exercised
   * against the network by any test in this package -- deliberately
   * untested, for future real-account wiring only.
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
