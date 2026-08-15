import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/** ProsHarness's own repo root, resolved relative to this test file (packages/review/test/helpers.ts -> ../../.. -> repo root). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** This package's own root -- used to invoke scripts/build-diagrams.ts as a subprocess with the right cwd. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export interface FixtureRepo {
  repoRoot: string;
  baseSha: string;
  headSha: string;
}

/**
 * Builds a real, throwaway git repo (not a `git worktree` -- a fresh
 * `git init`) with:
 *   - base commit: packages/foo/src/auth.ts, packages/foo/test/auth.test.ts
 *     (sibling test present), packages/foo/src/untested.ts (no sibling
 *     test), packages/foo/src/net.ts (no sibling test), package-lock.json,
 *     README.md.
 *   - head commit:
 *       * auth.ts gains an added `throw` line (auth keyword + error
 *         handling change).
 *       * package-lock.json gains an added line (lockfile -- collapsed).
 *       * untested.ts gains added lines (no test coverage risk factor).
 *       * net.ts gains an added `fetch(...)` call (new external call).
 *
 * Mirrors the pattern already used in packages/implement/test/pipeline.test.ts
 * / e2e-m4.test.ts for building real throwaway git repos in tests.
 */
export async function makeFixtureRepo(): Promise<FixtureRepo> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "pros-review-fixture-"));
  await git(repoRoot, ["init", "-q", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test"]);

  await mkdir(path.join(repoRoot, "packages", "foo", "src"), { recursive: true });
  await mkdir(path.join(repoRoot, "packages", "foo", "test"), { recursive: true });

  await writeFile(path.join(repoRoot, "README.md"), "hello\n");
  await writeFile(path.join(repoRoot, "package-lock.json"), '{\n  "lockfileVersion": 1\n}\n');
  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "auth.ts"),
    "export function login(user: string): boolean {\n  return user.length > 0;\n}\n",
  );
  await writeFile(
    path.join(repoRoot, "packages", "foo", "test", "auth.test.ts"),
    "// placeholder test for auth.ts\n",
  );
  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "untested.ts"),
    "export function helper(): number {\n  return 1;\n}\n",
  );
  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "net.ts"),
    "export function ping(): void {\n  // no-op\n}\n",
  );

  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "base"]);
  const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);

  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "auth.ts"),
    [
      "export function login(user: string): boolean {",
      '  if (!user) throw new Error("auth failure: empty user");',
      "  return user.length > 0;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repoRoot, "package-lock.json"), '{\n  "lockfileVersion": 1,\n  "extra": true\n}\n');
  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "untested.ts"),
    [
      "export function helper(): number {",
      "  return 1;",
      "}",
      "",
      "export function helper2(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "packages", "foo", "src", "net.ts"),
    [
      "export function ping(): void {",
      '  fetch("https://example.com/ping");',
      "}",
      "",
    ].join("\n"),
  );

  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "head"]);
  const headSha = await git(repoRoot, ["rev-parse", "HEAD"]);

  return { repoRoot, baseSha, headSha };
}
