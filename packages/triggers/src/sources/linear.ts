// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Linear. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic.

import { readFile } from "node:fs/promises";
import type { Signal, TriggerSource } from "../types.js";

export interface LinearIssueFixture {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  updatedAt: string;
  labels?: string[];
}

export interface LinearSourceOptions {
  /** Path to a JSON fixture -- an array of LinearIssueFixture. Used for tests and for offline/local dev. */
  fixturePath?: string;
  /** Real Linear GraphQL API URL. Only used if BOTH apiUrl and apiKey are set. */
  apiUrl?: string;
  apiKey?: string;
}

export class LinearSource implements TriggerSource {
  readonly id = "linear";

  constructor(private readonly opts: LinearSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }
    if (this.opts.apiUrl && this.opts.apiKey) {
      return this.fetchFromApi(this.opts.apiUrl, this.opts.apiKey);
    }
    // Not configured -- degrade gracefully, this is the expected "no Linear
    // account wired up" case, not an error.
    return [];
  }

  private async fetchFromFixture(fixturePath: string): Promise<Signal[]> {
    let raw: string;
    try {
      raw = await readFile(fixturePath, "utf8");
    } catch (err: any) {
      throw new Error(`LinearSource: could not read fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    let issues: LinearIssueFixture[];
    try {
      issues = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`LinearSource: malformed JSON fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    if (!Array.isArray(issues)) {
      throw new Error(`LinearSource: fixture at ${fixturePath} must be a JSON array of issues`);
    }
    return issues.map((issue) => this.toSignal(issue));
  }

  private toSignal(issue: LinearIssueFixture): Signal {
    return {
      sourceId: this.id,
      externalId: issue.id,
      kind: "issue",
      title: issue.title,
      body: issue.description ?? "",
      url: issue.url,
      raisedAt: issue.updatedAt,
    };
  }

  /**
   * Real Linear GraphQL fetch. NOT exercised against the network by any
   * test in this package -- deliberately untested, for future real-account
   * wiring only. Read-only query, no mutations, matching this adapter's
   * READ-ONLY ADAPTER contract above.
   */
  private async fetchFromApi(apiUrl: string, apiKey: string): Promise<Signal[]> {
    const query = `query { issues(first: 50, orderBy: updatedAt) { nodes { id identifier title description url updatedAt labels { nodes { name } } } } }`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`LinearSource: Linear API request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { data?: { issues?: { nodes?: LinearIssueFixture[] } } };
    const nodes = json.data?.issues?.nodes ?? [];
    return nodes.map((issue) => this.toSignal(issue));
  }
}
