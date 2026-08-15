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

/**
 * Best-effort cleanup of any systemd --user scope units matching a prefix,
 * for test hygiene.
 *
 * Also waits for each matched unit to be fully unloaded (LoadState
 * not-found) before returning, not just fired-and-forgotten kill/stop
 * calls. This closes a real, reproduced-on-this-host race: back-to-back
 * `systemd-run --scope --collect` churn (many transient scopes created and
 * torn down within a few seconds, which is exactly what this test suite
 * does but no real usage of this codebase ever does -- one attempt runs at
 * a time) can leave a just-stopped scope's teardown still settling in
 * systemd's own bookkeeping when the *next* test immediately creates a new
 * scope; that overlap was observed to make the new scope's cgroup
 * disappear (every member, simultaneously, via an untrappable signal)
 * within a couple hundred ms of a confirmed-live start. Confirming the
 * previous scope is truly gone -- not just asking it to stop -- removes
 * the overlap at its source instead of padding every `Guardian.launch()`
 * caller (including latency-sensitive ones) with unconditional extra delay.
 */
export async function killUnitsMatching(prefix: string): Promise<void> {
  let units: string[] = [];
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "list-units",
      "--all",
      "--no-legend",
      "--plain",
      `${prefix}*`,
    ]);
    units = stdout
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
  for (const u of units) {
    await waitFor(async () => {
      const loadState = (
        await execFileAsync("systemctl", ["--user", "show", u, "--property=LoadState", "--value"]).catch(() => ({
          stdout: "not-found",
        }))
      ).stdout.trim();
      return loadState === "not-found" || loadState === "";
    }, 1000).catch(() => undefined);
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
