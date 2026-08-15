import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../app/api/new/browse/route.js";

function request(directory: string): NextRequest {
  return new NextRequest(`http://localhost/api/new/browse?path=${encodeURIComponent(directory)}`);
}

test("browse: returns child folders, canonical path, and git metadata without files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pros-browse-"));
  try {
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "not returned by the browser");

    const res = await GET(request(root));
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.currentPath, root);
    assert.equal(data.isGitRepo, true);
    assert.deepEqual(data.directories, [{ name: "src", path: path.join(root, "src") }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browse: rejects a file path instead of treating it as a folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pros-browse-file-"));
  const file = path.join(root, "README.md");
  try {
    await writeFile(file, "content");
    const res = await GET(request(file));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dialog regression: paper-grain must not override fixed modal positioning", async () => {
  // This is intentionally a source-level guard for the shared CSS rule. The
  // visual failure was global: every Radix dialog showed its blur overlay but
  // positioned the panel in normal document flow below the viewport.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.paper-grain\s*\{\s*\/\*/s);
  assert.doesNotMatch(css, /\.paper-grain\s*\{[^}]*position:\s*relative/s);
});
