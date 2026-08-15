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
  team?: string;
  teamKey?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}

export interface LinearIssueQuery {
  team?: string;
  search?: string;
  status?: string;
  limit?: number;
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
      team: { type: "string" },
      teamKey: { type: "string" },
      status: { type: "string" },
      priority: { type: "string" },
      assignee: { type: "string" },
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
  /** Optional read-only issue-browser filters. */
  team?: string;
  search?: string;
  status?: string;
  limit?: number;
}

export class LinearSource implements TriggerSource {
  readonly id = "linear";

  constructor(private readonly opts: LinearSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    const issues = await this.fetchIssues();
    return issues.map((issue) => this.toSignal(issue));
  }

  /** Read issue records without discarding fields needed by the dashboard. */
  async fetchIssues(query: LinearIssueQuery = {}): Promise<LinearIssueFixture[]> {
    const request: LinearIssueQuery = {
      team: query.team ?? this.opts.team,
      search: query.search ?? this.opts.search,
      status: query.status ?? this.opts.status,
      limit: query.limit ?? this.opts.limit,
    };

    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }

    try {
      return await this.fetchFromMcp(request);
    } catch (mcpErr: any) {
      if (this.opts.apiUrl && this.opts.apiKey) {
        return this.fetchFromApi(this.opts.apiUrl, this.opts.apiKey, request);
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

  private async fetchFromFixture(fixturePath: string): Promise<LinearIssueFixture[]> {
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
    return issues;
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
  private async fetchFromMcp(query: LinearIssueQuery): Promise<LinearIssueFixture[]> {
    const session = this.opts.mcpSession ?? new RealClaudeSession();
    const teamScope = query.team
      ? `Only return issues belonging to the Linear team ${JSON.stringify(query.team)}.`
      : "Return issues across the teams visible to the current user.";
    const searchScope = query.search
      ? `Match the text search ${JSON.stringify(query.search)} against identifier, title, and description.`
      : "Do not apply a text search filter.";
    const statusScope = query.status
      ? `Only return issues whose workflow status is ${JSON.stringify(query.status)}.`
      : "Do not apply a status filter.";
    const limit = Math.max(1, Math.min(query.limit ?? 100, 100));
    const prompt = [
      "Use your already-connected Linear MCP server's READ-ONLY tools",
      "(list issues / search issues / get issue -- never create, update,",
      "comment on, or otherwise write to anything in Linear) to retrieve up",
      `${teamScope} ${searchScope} ${statusScope}`,
      `Retrieve up to ${limit} recently-updated issues.`,
      "",
      "Respond with ONLY a JSON array (matching the provided schema) of",
      "objects shaped like:",
      '  { "id": string, "identifier": string, "title": string,',
      '    "description"?: string, "url"?: string, "updatedAt": string (ISO),',
      '    "labels"?: string[], "team"?: string, "teamKey"?: string,',
      '    "status"?: string, "priority"?: string, "assignee"?: string }',
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
    return issues;
  }

  /**
   * Real Linear GraphQL fetch. NOT exercised against the network by any
   * test in this package -- deliberately untested, for future real-account
   * wiring only. Read-only query, no mutations, matching this adapter's
   * READ-ONLY ADAPTER contract above. Documented headless-reliability
   * fallback when the MCP path is unavailable.
   */
  private async fetchFromApi(apiUrl: string, apiKey: string, options: LinearIssueQuery): Promise<LinearIssueFixture[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
    const teamFilter = options.team
      ? `, filter: { team: { key: { eq: ${JSON.stringify(options.team)} } } }`
      : "";
    const query = `query { issues(first: ${limit}, orderBy: updatedAt${teamFilter}) { nodes { id identifier title description url updatedAt team { name key } state { name } priority priorityLabel assignee { name } labels { nodes { name } } } } }`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`LinearSource: Linear API request failed with status ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: {
        issues?: {
          nodes?: Array<LinearIssueFixture & {
            team?: { name?: string; key?: string };
            state?: { name?: string };
            priorityLabel?: string;
            assignee?: { name?: string };
            labels?: { nodes?: Array<{ name?: string }> };
          }>;
        };
      };
    };
    const nodes = json.data?.issues?.nodes ?? [];
    return nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      updatedAt: issue.updatedAt,
      labels: issue.labels?.nodes?.flatMap((label) => label.name ? [label.name] : []),
      team: issue.team?.name,
      teamKey: issue.team?.key,
      status: issue.state?.name,
      priority: issue.priorityLabel ?? issue.priority,
      assignee: issue.assignee?.name,
    }));
  }
}
