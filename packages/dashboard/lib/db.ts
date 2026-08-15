/**
 * Rebuild-then-open helper for the SQLite index. Per the brief: "rebuilds a
 * fresh SQLite db file from the journal + raw logs every call -- cheap
 * enough at single-user scale to call synchronously per dashboard page
 * load." Every page that needs index data calls this at the top of its
 * server-component render; there is no caching layer, deliberately, so the
 * dashboard can never show stale data relative to the on-disk journal.
 */
import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { rebuildIndex, type RebuildReport } from "@pros/index";

export interface IndexHandle {
  db: Database.Database;
  report: RebuildReport;
}

export async function rebuildAndOpenIndex(dbPath: string, runsRoot: string): Promise<IndexHandle> {
  // The index db's parent directory (e.g. ~/.pros) may not exist yet on a
  // completely fresh install -- rebuildIndex itself doesn't create it.
  await mkdir(path.dirname(dbPath), { recursive: true });
  const report = await rebuildIndex(dbPath, runsRoot);
  const db = new Database(dbPath, { readonly: true });
  return { db, report };
}
