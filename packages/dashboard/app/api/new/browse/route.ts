/**
 * GET /api/new/browse?path=/some/directory
 *
 * Small, local-only directory browser for the New Session form. A browser's
 * native directory picker exposes selected files, not the absolute path the
 * server needs to run git and create worktrees, so this endpoint returns only
 * directory names and repo metadata; it never reads or returns file content.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getDefaultRepoRoot } from "../../../../lib/config";

export interface BrowseDirectoryEntry {
  name: string;
  path: string;
}

export interface BrowseDirectoryResponse {
  ok: true;
  currentPath: string;
  parentPath?: string;
  isGitRepo: boolean;
  directories: BrowseDirectoryEntry[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestedPath = req.nextUrl.searchParams.get("path")?.trim() || getDefaultRepoRoot();
  const candidate = path.resolve(requestedPath);

  let currentPath: string;
  try {
    currentPath = await realpath(candidate);
    const info = await stat(currentPath);
    if (!info.isDirectory()) {
      return NextResponse.json({ error: "selected path is not a directory" }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json(
      { error: `could not open directory: ${err?.code === "ENOENT" ? "path does not exist" : err?.message ?? String(err)}` },
      { status: 400 },
    );
  }

  let directories: BrowseDirectoryEntry[];
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });
    directories = entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".git")
      .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } catch (err: any) {
    return NextResponse.json({ error: `could not read directory: ${err?.message ?? String(err)}` }, { status: 400 });
  }

  const parent = path.dirname(currentPath);
  const response: BrowseDirectoryResponse = {
    ok: true,
    currentPath,
    ...(parent !== currentPath ? { parentPath: parent } : {}),
    isGitRepo: await hasGitMetadata(currentPath),
    directories,
  };
  return NextResponse.json(response);
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    const info = await stat(path.join(directory, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}
