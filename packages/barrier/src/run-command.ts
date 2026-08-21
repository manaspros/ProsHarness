/**
 * Generic timeout-guarded process spawning with whole-process-group kill on
 * expiry. Factored out of `git.ts`'s `runGit` (see that file's doc comment
 * for the root-cause incident this pattern exists for -- a hung child must
 * become a recorded failure, never silence) so a second caller doesn't
 * reimplement the timeout/group-kill dance.
 *
 * Deliberately lower-level than `runGit`: this function never THROWS on a
 * nonzero exit code or a timeout -- both are legitimate, recordable OUTCOMES
 * for an arbitrary command (unlike git, where a nonzero exit is always an
 * operational error the caller didn't ask to observe). It always RESOLVES
 * with the full result and lets the caller decide what "failure" means for
 * its own case. `runGit` below is now a thin wrapper that restores its
 * original throw-on-nonzero-exit / `GitTimeoutError` contract on top of this.
 */

import { spawn } from "node:child_process";

export interface SpawnTimeoutOptions {
  /** Executable name, or (with `shell: true`) a full shell command line. */
  command: string;
  /** Ignored when `shell: true` -- the shell parses `command` itself. */
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** Run via `/bin/sh -c` so `command` can be a full shell command line (pipes, flags, etc.), not just an executable name. */
  shell?: boolean;
}

export interface SpawnTimeoutResult {
  stdout: string;
  stderr: string;
  /** The process's own exit code. Never set together with `timedOut`. */
  exitCode: number | null;
  /** True iff the timeout fired and the whole process group was killed before the child exited on its own. */
  timedOut: boolean;
  durationMs: number;
}

/**
 * Spawns `command` with a hard wall-clock timeout. `detached: true` puts the
 * child in its own process group; on expiry we kill that whole group with
 * `process.kill(-pid, ...)` (note the negative pid) rather than just the
 * immediate child, so anything it forked (a stuck test runner's workers, a
 * pinentry/gpg-agent helper, etc.) actually dies instead of leaking.
 */
export function spawnWithTimeout(options: SpawnTimeoutOptions): Promise<SpawnTimeoutResult> {
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    // With `shell: true`, node passes `command` (with `args` appended) to
    // `/bin/sh -c` as one line -- so a shell-mode caller puts the whole
    // command line in `command` and leaves `args` empty.
    const child = spawn(options.command, options.shell ? [] : options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: !!options.shell,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already dead, or no process-group support on this platform -- best effort.
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      resolve({ stdout, stderr, exitCode: null, timedOut: true, durationMs: Date.now() - start });
    }, options.timeoutMs);

    const onOverflow = (which: "stdout" | "stderr") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      reject(new Error(`${options.command} ${options.args.join(" ")} (cwd=${options.cwd}) exceeded maxBuffer on ${which}`));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) onOverflow("stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) onOverflow("stderr");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false, durationMs: Date.now() - start });
    });
  });
}
