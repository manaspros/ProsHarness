/**
 * Durable, filesystem-backed status store: one JSON file per job under
 * `${statusDir}/<jobName>.json`. Written with the exact same atomic
 * temp-write + fsync(file) + rename + fsync(dir) discipline as
 * `@pros/lease`'s `writeLeaseRecord`/`fsyncDir` (packages/lease/src/concurrency-lease.ts)
 * -- copied rather than reinvented, per the M7 brief.
 *
 * Reads are tolerant per this project's house style (D12): a missing or
 * corrupt status file is never an error, it just means "never run".
 */

import { mkdir, open, rename, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { JobStatus } from "./types.js";

function statusFilePath(statusDir: string, jobName: string): string {
  return path.join(statusDir, `${jobName}.json`);
}

async function fsyncDir(dirPath: string): Promise<void> {
  const dh = await open(dirPath, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

export async function writeJobStatus(statusDir: string, status: JobStatus): Promise<void> {
  await mkdir(statusDir, { recursive: true });
  const finalPath = statusFilePath(statusDir, status.name);
  const tmpPath = path.join(
    statusDir,
    `.${status.name}.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(JSON.stringify(status, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, finalPath);
  await fsyncDir(statusDir);
}

/** Tolerant: missing/corrupt file -> `{ name: jobName, lastStatus: "never-run" }`, never throws. */
export async function readJobStatus(statusDir: string, jobName: string): Promise<JobStatus> {
  const filePath = statusFilePath(statusDir, jobName);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as JobStatus;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.name !== "string" || typeof parsed.lastStatus !== "string") {
      return { name: jobName, lastStatus: "never-run" };
    }
    return parsed;
  } catch {
    return { name: jobName, lastStatus: "never-run" };
  }
}

/** Reads every *.json in statusDir. Tolerant: a missing statusDir yields []. */
export async function listJobStatuses(statusDir: string): Promise<JobStatus[]> {
  let names: string[];
  try {
    names = await readdir(statusDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const jsonNames = names.filter((n) => n.endsWith(".json") && !n.startsWith("."));
  const statuses: JobStatus[] = [];
  for (const name of jsonNames) {
    const jobName = name.slice(0, -".json".length);
    statuses.push(await readJobStatus(statusDir, jobName));
  }
  return statuses;
}
