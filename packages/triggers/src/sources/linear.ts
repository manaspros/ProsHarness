// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Linear. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic. This includes the MCP path below: the prompt handed to
// the model explicitly instructs read-only tool use (list/search/fetch
// issues) and never instructs it to create, comment on, or otherwise
// mutate anything in Linear.

import { readFile } from "node:fs/promises";
import type { ModelSession } from "@pros/plan";
import { RealClaudeSession } from "@pros/plan";
import type { Signal, TriggerSource } from "../types.js";
import { runMcpQuery } from "../mcp-fetch.js";

export interface LinearIssueFixture {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  updatedAt: string;
  labels?: string[];
}

const LINEAR_ISSUE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      identifier: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      updatedAt: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
    },
    required: ["id", "identifier", "title", "updatedAt"],
  },
} as const;

export interface LinearSourceOptions {
  /** Path to a JSON fixture -- an array of LinearIssueFixture. Used for tests and for offline/local dev. */
  fixturePath?: string;
  /** Real Linear GraphQL API URL. Only used if BOTH apiUrl and apiKey are set. */
  apiUrl?: string;
  apiKey?: string;
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

export class LinearSource implements TriggerSource {
  readonly id = "linear";

  constructor(private readonly opts: LinearSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }

    try {
      return await this.fetchFromMcp();
    } catch (mcpErr: any) {
      if (this.opts.apiUrl && this.opts.apiKey) {
        return this.fetchFromApi(this.opts.apiUrl, this.opts.apiKey);
      }
      // No headless fallback configured -- this must be observable (see
      // runner.ts's sourceFailures), never a silent []. An unattended
      // daemon whose Linear MCP server disconnected mid-session needs to
      // surface that loudly, not look identical to "no Linear account
      // wired up at all".
      throw new Error(
        `LinearSource: MCP path unavailable (Linear MCP server not connected, or timed out) and no PROS_LINEAR_API_KEY fallback configured: ${mcpErr?.message ?? mcpErr}`,
      );
    }
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
   * MCP-first path: asks an already-connected Claude session to use its
   * Linear MCP server's read-only tools (list/search/fetch issues -- never
   * create/update/comment) and respond with ONLY JSON matching
   * LinearIssueFixture[]. Bounded by mcpTimeoutMs.
   */
  private async fetchFromMcp(): Promise<Signal[]> {
    const session = this.opts.mcpSession ?? new RealClaudeSession();
    const prompt = [
      "Use your already-connected Linear MCP server's READ-ONLY tools",
      "(list issues / search issues / get issue -- never create, update,",
      "comment on, or otherwise write to anything in Linear) to retrieve up",
      "to 50 recently-updated issues assigned to or relevant to the current",
      "user.",
      "",
      "Respond with ONLY a JSON array (matching the provided schema) of",
      "objects shaped like:",
      '  { "id": string, "identifier": string, "title": string,',
      '    "description"?: string, "url"?: string, "updatedAt": string (ISO),',
      '    "labels"?: string[] }',
      "No prose, no markdown fences -- just the JSON array. An empty array",
      "is a valid response if there are no relevant issues.",
    ].join("\n");

    const issues = await runMcpQuery<LinearIssueFixture[]>({
      session,
      prompt,
      schema: LINEAR_ISSUE_SCHEMA,
      timeoutMs: this.opts.mcpTimeoutMs ?? 20_000,
      label: "LinearSource",
    });
    if (!Array.isArray(issues)) {
      throw new Error("LinearSource: MCP query returned non-array JSON");
    }
    return issues.map((issue) => this.toSignal(issue));
  }

  /**
   * Real Linear GraphQL fetch. NOT exercised against the network by any
   * test in this package -- deliberately untested, for future real-account
   * wiring only. Read-only query, no mutations, matching this adapter's
   * READ-ONLY ADAPTER contract above. Documented headless-reliability
   * fallback when the MCP path is unavailable.
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
