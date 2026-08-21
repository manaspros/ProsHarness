import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A real temporary git repository with one empty commit, shared by every
 * mcp fixture test that needs a repo to point a barrier attempt's `cwd` at.
 *
 * `commit.gpgsign` is set to `false` locally so this repo never depends on
 * the operator's global signing config -- a real `git commit` under
 * `commit.gpgsign = true` blocks forever on an interactive signing prompt
 * with nothing non-interactive to answer it (see packages/barrier/src/git.ts
 * for the preflight/timeout guards that address this in production paths).
 * Fixtures exercise git plumbing, not the user's signing setup.
 */
export async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-mcp-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
