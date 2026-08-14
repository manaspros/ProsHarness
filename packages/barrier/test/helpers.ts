import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

export const FIXTURE_PATH = path.resolve(import.meta.dirname, "../../../test/fixtures/forking-child.ts");

export async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-kt-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

export async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pros-kt-run-"));
  return dir;
}

export function uniqueUnitSuffix(): string {
  return randomUUID().slice(0, 8);
}

/** Best-effort cleanup of any systemd --user scope units matching a prefix, for test hygiene. */
export async function killUnitsMatching(prefix: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "list-units",
      "--all",
      "--no-legend",
      "--plain",
      `${prefix}*`,
    ]);
    const units = stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean) as string[];
    for (const u of units) {
      await execFileAsync("systemctl", ["--user", "kill", "--signal=KILL", u]).catch(() => undefined);
      await execFileAsync("systemctl", ["--user", "stop", u]).catch(() => undefined);
    }
  } catch {
    /* systemctl list-units failing is not fatal to test cleanup */
  }
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}
