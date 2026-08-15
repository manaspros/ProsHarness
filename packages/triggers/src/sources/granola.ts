// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Granola. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic. This includes the MCP path below: the prompt handed to
// the model explicitly instructs read-only tool use (list/search/fetch
// meeting notes) and never instructs it to create or otherwise write
// anything in Granola.

import { readFile } from "node:fs/promises";
import type { ModelSession } from "@pros/plan";
import { RealClaudeSession } from "@pros/plan";
import type { Signal, TriggerSource } from "../types.js";
import { runMcpQuery } from "../mcp-fetch.js";

export interface GranolaNoteFixture {
  id: string;
  title: string;
  summary?: string;
  actionItems: string[];
  createdAt: string;
  url?: string;
}

const GRANOLA_NOTE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      actionItems: { type: "array", items: { type: "string" } },
      createdAt: { type: "string" },
      url: { type: "string" },
    },
    required: ["id", "title", "actionItems", "createdAt"],
  },
} as const;

export interface GranolaSourceOptions {
  /** Path to a JSON fixture -- an array of GranolaNoteFixture. Used for tests and offline/local dev. */
  fixturePath?: string;
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

export class GranolaSource implements TriggerSource {
  readonly id = "granola";

  constructor(private readonly opts: GranolaSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }

    try {
      return await this.fetchFromMcp();
    } catch (mcpErr: any) {
      if (this.opts.apiKey) {
        return this.fetchFromApi(this.opts.apiKey);
      }
      // No headless fallback configured -- observable failure (see
      // runner.ts's sourceFailures), never a silent [].
      throw new Error(
        `GranolaSource: MCP path unavailable (Granola MCP server not connected, or timed out) and no PROS_GRANOLA_API_KEY fallback configured: ${mcpErr?.message ?? mcpErr}`,
      );
    }
  }

  private async fetchFromFixture(fixturePath: string): Promise<Signal[]> {
    let raw: string;
    try {
      raw = await readFile(fixturePath, "utf8");
    } catch (err: any) {
      throw new Error(`GranolaSource: could not read fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    let notes: GranolaNoteFixture[];
    try {
      notes = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`GranolaSource: malformed JSON fixture at ${fixturePath}: ${err?.message ?? err}`);
    }
    if (!Array.isArray(notes)) {
      throw new Error(`GranolaSource: fixture at ${fixturePath} must be a JSON array of notes`);
    }
    return notes.flatMap((note) => this.toSignals(note));
  }

  /** One Signal PER action item -- each is an independent candidate task, and externalId is `${note.id}:${index}` so items within one note dedup independently. */
  private toSignals(note: GranolaNoteFixture): Signal[] {
    return note.actionItems.map((item, index) => ({
      sourceId: this.id,
      externalId: `${note.id}:${index}`,
      kind: "action-item",
      title: item,
      body: `From meeting "${note.title}": ${note.summary ?? ""}`.trim(),
      url: note.url,
      raisedAt: note.createdAt,
    }));
  }

  /**
   * MCP-first path: asks an already-connected Claude session to use its
   * Granola MCP server's READ-ONLY tools (list/search/fetch meeting notes
   * -- never create or otherwise write) and respond with ONLY JSON
   * matching GranolaNoteFixture[]. Bounded by mcpTimeoutMs.
   */
  private async fetchFromMcp(): Promise<Signal[]> {
    const session = this.opts.mcpSession ?? new RealClaudeSession();
    const prompt = [
      "Use your already-connected Granola MCP server's READ-ONLY tools",
      "(list/search/fetch meeting notes -- never create or otherwise write",
      "anything in Granola) to retrieve recent meeting notes with their",
      "action items.",
      "",
      "Respond with ONLY a JSON array (matching the provided schema) of",
      "objects shaped like:",
      '  { "id": string, "title": string, "summary"?: string,',
      '    "actionItems": string[], "createdAt": string (ISO), "url"?: string }',
      "No prose, no markdown fences -- just the JSON array. An empty array",
      "is a valid response if there are no relevant notes.",
    ].join("\n");

    const notes = await runMcpQuery<GranolaNoteFixture[]>({
      session,
      prompt,
      schema: GRANOLA_NOTE_SCHEMA,
      timeoutMs: this.opts.mcpTimeoutMs ?? 20_000,
      label: "GranolaSource",
    });
    if (!Array.isArray(notes)) {
      throw new Error("GranolaSource: MCP query returned non-array JSON");
    }
    return notes.flatMap((note) => this.toSignals(note));
  }

  /**
   * Real Granola API fetch. NOT exercised against the network by any test
   * in this package -- deliberately untested, for future real-account
   * wiring only. Granola's actual API shape is unconfirmed; this is a
   * placeholder for whenever that account is reconnected. Documented
   * headless-reliability fallback when the MCP path is unavailable.
   */
  private async fetchFromApi(apiKey: string): Promise<Signal[]> {
    const res = await fetch("https://api.granola.ai/v1/notes", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`GranolaSource: Granola API request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { notes?: GranolaNoteFixture[] };
    const notes = json.notes ?? [];
    return notes.flatMap((note) => this.toSignals(note));
  }
}
