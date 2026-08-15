// READ-ONLY ADAPTER: must never call an endpoint that posts, comments,
// replies, or writes to Granola. Any outbound action for this source is a
// future feature that MUST go through an explicit human-approval gate --
// never automatic.

import { readFile } from "node:fs/promises";
import type { Signal, TriggerSource } from "../types.js";

export interface GranolaNoteFixture {
  id: string;
  title: string;
  summary?: string;
  actionItems: string[];
  createdAt: string;
  url?: string;
}

export interface GranolaSourceOptions {
  /** Path to a JSON fixture -- an array of GranolaNoteFixture. Used for tests and offline/local dev. */
  fixturePath?: string;
  apiKey?: string;
}

export class GranolaSource implements TriggerSource {
  readonly id = "granola";

  constructor(private readonly opts: GranolaSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    if (this.opts.fixturePath) {
      return this.fetchFromFixture(this.opts.fixturePath);
    }
    if (this.opts.apiKey) {
      return this.fetchFromApi(this.opts.apiKey);
    }
    // Not configured -- degrade gracefully.
    return [];
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
   * Real Granola API fetch. NOT exercised against the network by any test
   * in this package -- deliberately untested, for future real-account
   * wiring only. Granola's actual API shape is unconfirmed; this is a
   * placeholder for whenever that account is reconnected.
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
