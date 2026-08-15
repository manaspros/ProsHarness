import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HistoryLine {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
  lineIndex: number;
}

/** Returns PROS_CLAUDE_HOME if set, else ~/.claude. */
export function resolveHistoryRoot(): string {
  const fromEnv = process.env.PROS_CLAUDE_HOME;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".claude");
}

/**
 * Reads <historyRoot>/history.jsonl line by line, tolerantly, and returns the
 * lines that have a non-empty `display` string. lineIndex is the 0-based
 * index of the line within the raw file (counting ALL lines, including ones
 * later filtered out), so it remains a stable position marker.
 */
export function readHistoryLines(historyRoot: string): HistoryLine[] {
  const historyPath = path.join(historyRoot, "history.jsonl");
  if (!existsSync(historyPath)) {
    return [];
  }
  const raw = readFileSync(historyPath, "utf8");
  const lines = raw.split("\n");
  const result: HistoryLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed?.display !== "string" || parsed.display.length === 0) {
      continue;
    }
    result.push({
      display: parsed.display,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
      project: typeof parsed.project === "string" ? parsed.project : "",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      lineIndex: i,
    });
  }
  return result;
}

/**
 * Returns absolute paths to every session transcript *.jsonl file directly
 * under <historyRoot>/projects/<bucket>/ -- one level deep from the bucket
 * dir. Explicitly excludes anything nested deeper (e.g. a subagents/
 * subfolder).
 */
export function listSessionTranscriptFiles(historyRoot: string): string[] {
  const projectsDir = path.join(historyRoot, "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }
  const results: string[] = [];
  const buckets = readdirSync(projectsDir);
  for (const bucket of buckets) {
    const bucketPath = path.join(projectsDir, bucket);
    let st;
    try {
      st = statSync(bucketPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const entryPath = path.join(bucketPath, entry);
      let entrySt;
      try {
        entrySt = statSync(entryPath);
      } catch {
        continue;
      }
      if (entrySt.isFile()) {
        results.push(entryPath);
      }
    }
  }
  return results;
}

/** Reads a session transcript file, JSON-parsing each line tolerantly. */
export function readSessionTranscript(filePath: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const rows: unknown[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}
