import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A real temporary git repository with one commit -- no mocking git, per the M1 lesson. */
export async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-wt-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

export interface Sandbox {
  repoRoot: string;
  worktreesRoot: string;
  runsRoot: string;
}

export async function makeSandbox(): Promise<Sandbox> {
  const repoRoot = await makeTempRepo();
  const worktreesRoot = await mkdtemp(path.join(tmpdir(), "pros-wt-worktrees-"));
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-wt-runs-"));
  return { repoRoot, worktreesRoot, runsRoot };
}

export async function cleanupSandbox(sb: Sandbox): Promise<void> {
  await rm(sb.repoRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(sb.worktreesRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(sb.runsRoot, { recursive: true, force: true }).catch(() => undefined);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export { mkdir, writeFile };
