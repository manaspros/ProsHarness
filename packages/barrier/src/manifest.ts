import { createHash } from "node:crypto";
import { rename, writeFile, readFile, unlink, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Journal } from "./journal.js";
import type { LaunchConfig, Manifest } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * A working-state hash covering staged, unstaged, AND untracked files.
 * `git diff` alone misses untracked files -- exactly where a half-written
 * new file hides -- so this combines three sources:
 *   - `git diff` (unstaged tracked changes)
 *   - `git diff --cached` (staged changes)
 *   - the raw bytes of every untracked, non-ignored file, path-sorted
 */
export async function computeWorkingStateHash(cwd: string): Promise<string> {
  const [unstaged, staged, untrackedList] = await Promise.all([
    git(cwd, ["diff", "--no-color"]),
    git(cwd, ["diff", "--no-color", "--cached"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const hash = createHash("sha256");
  hash.update("unstaged\0");
  hash.update(unstaged);
  hash.update("staged\0");
  hash.update(staged);

  const untrackedFiles = untrackedList.split("\n").filter(Boolean).sort();
  hash.update("untracked\0");
  for (const rel of untrackedFiles) {
    hash.update(rel);
    hash.update("\0");
    try {
      const bytes = await readFile(path.join(cwd, rel));
      hash.update(bytes);
    } catch {
      // File vanished between listing and reading -- record that fact so the
      // hash still reflects a real observation instead of silently skipping.
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function computeHeadSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export interface ManifestSnapshotInput {
  runId: string;
  cwd: string;
  baseSha: string;
  fenceEpoch: number;
  launchConfig: LaunchConfig;
}

export async function snapshotManifest(runDir: string, input: ManifestSnapshotInput): Promise<Manifest> {
  const [headSha, workingStateHash, cwdRealPath] = await Promise.all([
    computeHeadSha(input.cwd),
    computeWorkingStateHash(input.cwd),
    realpath(input.cwd),
  ]);

  const manifest: Manifest = {
    runId: input.runId,
    cwd: input.cwd,
    cwdRealPath,
    headSha,
    baseSha: input.baseSha,
    workingStateHash,
    fenceEpoch: input.fenceEpoch,
    launchConfig: input.launchConfig,
    createdAt: new Date().toISOString(),
  };

  await writeManifestAtomic(runDir, manifest);
  return manifest;
}

/** Atomic temp-write + rename, with fsync of the file and the containing directory. */
export async function writeManifestAtomic(runDir: string, manifest: Manifest): Promise<void> {
  const finalPath = path.join(runDir, "manifest.json");
  const tmpPath = path.join(runDir, `.manifest.json.tmp-${process.pid}-${Date.now()}`);
  const body = JSON.stringify(manifest, null, 2);

  const fh = await (await import("node:fs/promises")).open(tmpPath, "w");
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }

  await rename(tmpPath, finalPath);
  await Journal.fsyncDir(runDir);
}

export async function readManifest(runDir: string): Promise<Manifest | undefined> {
  try {
    const body = await readFile(path.join(runDir, "manifest.json"), "utf8");
    return JSON.parse(body) as Manifest;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

/** Test/injection hook: simulate a crash between temp-write and rename. */
export async function writeManifestTempOnly(runDir: string, manifest: Manifest): Promise<string> {
  const tmpPath = path.join(runDir, `.manifest.json.tmp-crashtest`);
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  return tmpPath;
}

export async function cleanupTemp(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch {
    /* already gone */
  }
}
