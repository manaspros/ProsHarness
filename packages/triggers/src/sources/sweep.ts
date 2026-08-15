// READ-ONLY ADAPTER: sweep only reads the local repo tree, never writes to
// it or to any external service. Any outbound action derived from a sweep
// finding is a future feature that MUST go through an explicit
// human-approval gate -- never automatic.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Signal, TriggerSource } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"]);
const TODO_PATTERN = /\b(TODO|FIXME|XXX)\b:?\s*(.*)$/;

export interface SweepSourceOptions {
  repoRoot: string;
}

/**
 * THE ONE SOURCE NEEDING NO CREDENTIALS. Scans the real repo tree for
 * TODO/FIXME/XXX comments -- a simple line-based scan (no real parser),
 * skipping node_modules/.git/dist and friends.
 *
 * This is the one source whose Signal already carries known-real file:line
 * evidence, so `admit.ts` puts that evidence straight into the description
 * text handed to the plan pipeline -- the resulting finding-session gets a
 * head start over sources that only have a description.
 */
export class SweepSource implements TriggerSource {
  readonly id = "sweep";

  constructor(private readonly opts: SweepSourceOptions) {}

  async fetchSignals(): Promise<Signal[]> {
    const signals: Signal[] = [];
    this.walk(this.opts.repoRoot, signals);
    return signals;
  }

  private walk(dir: string, signals: Signal[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(`SweepSource: could not read directory ${dir}: ${err?.message ?? err}`);
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(fullPath, signals);
      } else if (entry.isFile()) {
        this.scanFile(fullPath, signals);
      }
    }
  }

  private scanFile(fullPath: string, signals: Signal[]): void {
    let contents: string;
    try {
      contents = readFileSync(fullPath, "utf8");
    } catch {
      // Binary or unreadable file -- not a bug, just skip it.
      return;
    }
    const relPath = path.relative(this.opts.repoRoot, fullPath);
    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = TODO_PATTERN.exec(lines[i]);
      if (!match) continue;
      const commentText = (match[2] || match[1]).trim() || match[1];
      const lineNumber = i + 1;
      // externalId hashes file + trimmed comment text (NOT line number) so
      // the same TODO still dedups after nearby lines shift.
      const externalId = createHash("sha256").update(`${relPath}::${commentText}`).digest("hex");
      signals.push({
        sourceId: this.id,
        externalId,
        kind: "todo",
        title: `${match[1]} in ${relPath}`,
        body: lines[i].trim(),
        raisedAt: new Date().toISOString(),
        evidence: { file: relPath, line: lineNumber },
      });
    }
  }
}
