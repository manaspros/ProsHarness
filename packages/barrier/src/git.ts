/**
 * Shared, timeout-guarded git spawning plus a commit-signing preflight.
 *
 * Root cause this exists for (observed 2026-08-21, see docs/11-project-status.md):
 * a global `~/.gitconfig` with `commit.gpgsign = true` makes every `git commit`
 * attempt interactive signing (Touch ID / passphrase / ssh-agent prompt). A
 * non-interactive harness subprocess has nothing to answer that prompt with,
 * so the child never exits -- it HANGS rather than fails. That is fatal here:
 * the whole point of the barrier is that a human can walk away and trust a
 * run either finishes or durably parks, never spins forever unobserved.
 *
 * Two independent mitigations live here:
 *   - `checkGitCommitPreflight`: read-only, best-effort detection of the
 *     blocking condition BEFORE a commit is attempted, with an actionable
 *     remedy. Callers decide what to do with a blocked result.
 *   - `runGit`: every harness-spawned git call gets a hard wall-clock
 *     timeout, so a hang that slips past the preflight (or a hang for an
 *     unrelated reason) still surfaces as a recorded failure, not silence.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { spawnWithTimeout } from "./run-command.js";

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Reads the harness-wide git timeout override, following the PROS_ env convention. */
function gitTimeoutMsFromEnv(): number {
  const raw = process.env.PROS_GIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GIT_TIMEOUT_MS;
}

export interface GitTimeoutError extends Error {
  command: string;
  args: string[];
  timeoutMs: number;
  elapsedMs: number;
}

function isGitTimeoutError(err: unknown): err is GitTimeoutError {
  return err instanceof Error && (err as Partial<GitTimeoutError>).timeoutMs !== undefined;
}

export interface RunGitOptions {
  cwd: string;
  /** Overrides PROS_GIT_TIMEOUT_MS / the 30s default for this call only. */
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawns `git` with a hard wall-clock timeout. `detached: true` puts the
 * child in its own process group; on expiry we kill that whole group with
 * `process.kill(-pid, ...)` (note the negative pid) rather than just the
 * immediate child, so a stuck `git commit` and the `ssh-keygen`/pinentry/
 * gpg-agent helper processes it spawned actually die instead of leaking.
 * Rejects with a GitTimeoutError naming the command and elapsed ms so a
 * hang is a legible, recorded failure -- never silent.
 */
export async function runGit(args: string[], options: RunGitOptions): Promise<RunGitResult> {
  const timeoutMs = options.timeoutMs ?? gitTimeoutMsFromEnv();
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  // spawnWithTimeout (packages/barrier/src/run-command.ts) is the shared,
  // general-purpose timeout+group-kill primitive -- this function restores
  // git's own historical contract on top of it: throw a GitTimeoutError on
  // timeout, throw a plain Error on nonzero exit, resolve {stdout, stderr}
  // on success. Unlike a general command (see run-command.ts's doc comment),
  // a git subcommand failing is always this caller's operational error, not
  // a recordable "outcome" -- so this wrapper is what puts the throw back.
  const result = await spawnWithTimeout({ command: "git", args, cwd: options.cwd, timeoutMs, maxBuffer });

  if (result.timedOut) {
    const err = Object.assign(
      new Error(`git ${args.join(" ")} (cwd=${options.cwd}) timed out after ${result.durationMs}ms (limit ${timeoutMs}ms)`),
      { command: "git", args, timeoutMs, elapsedMs: result.durationMs },
    ) as GitTimeoutError;
    throw err;
  }

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${options.cwd}) exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

/** Convenience wrapper matching the `stdout`-only shape most call sites want. */
export async function git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const { stdout } = await runGit(args, { cwd, timeoutMs });
  return stdout;
}

export interface GitPreflightResult {
  /** True when a `git commit` in `cwd` would block on an interactive signing prompt. */
  blocked: boolean;
  /** What is misconfigured. Only set when blocked. */
  reason?: string;
  /** The exact command (or config change) that unblocks commits. Only set when blocked. */
  remedy?: string;
}

async function gitConfigGet(cwd: string, key: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], { cwd, env, timeout: 5_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    // Unset keys exit non-zero -- that's a normal "not configured" result, not an error.
    return undefined;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** True iff the ssh key at `signingKeyPath` has a matching identity loaded in `ssh-agent`. */
async function isSshKeyLoadedInAgent(signingKeyPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const resolvedPath = expandHome(signingKeyPath);
  let fingerprint: string;
  try {
    const { stdout } = await execFileAsync("ssh-keygen", ["-lf", resolvedPath], { timeout: 5_000 });
    // Format: "<bits> SHA256:<fingerprint> <comment> (<type>)"
    fingerprint = stdout.trim().split(/\s+/)[1] ?? "";
    if (!fingerprint) return false;
  } catch {
    // Can't read/fingerprint the configured key at all -- treat as not usable.
    return false;
  }
  try {
    const { stdout } = await execFileAsync("ssh-add", ["-l"], { env, timeout: 5_000 });
    return stdout.includes(fingerprint);
  } catch {
    // Exit 2: ssh-agent not reachable. Exit 1: agent has no identities loaded. Both mean "not loaded".
    return false;
  }
}

/**
 * Read-only check for whether `git commit` in `cwd` would block on
 * interactive signing. Never mutates git config and never touches
 * ssh-agent/gpg-agent state -- only inspects it.
 *
 * Covers the observed incident fully (gpg.format=ssh with no agent
 * identity loaded). For gpg.format=openpgp/unset we only catch the
 * unambiguous case (no signing key configured at all): safely probing a
 * cached gpg-agent passphrase risks triggering a real prompt, which is
 * exactly the hang this function exists to avoid causing.
 *
 * `env` defaults to `process.env` (real callers always want the operator's
 * real merged git config); tests override it with `GIT_CONFIG_GLOBAL=/dev/null`
 * etc. to get a hermetic result independent of whatever this machine's own
 * `~/.gitconfig`/ssh-agent happens to have loaded right now.
 */
export async function checkGitCommitPreflight(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GitPreflightResult> {
  const gpgsign = await gitConfigGet(cwd, "commit.gpgsign", env);
  if (gpgsign?.toLowerCase() !== "true") {
    return { blocked: false };
  }

  const format = (await gitConfigGet(cwd, "gpg.format", env)) ?? "openpgp";
  const signingKey = await gitConfigGet(cwd, "user.signingkey", env);

  if (!signingKey) {
    return {
      blocked: true,
      reason: "commit.gpgsign is true but user.signingkey is unset",
      remedy: `set a signing key (git -C ${cwd} config user.signingkey <key>), or disable signing for this repo: git -C ${cwd} config commit.gpgsign false`,
    };
  }

  if (format === "ssh") {
    const loaded = await isSshKeyLoadedInAgent(signingKey, env);
    if (!loaded) {
      const keyForAdd = signingKey.replace(/\.pub$/, "");
      return {
        blocked: true,
        reason: `commit.gpgsign is true with gpg.format=ssh, but ${signingKey} has no matching identity loaded in ssh-agent`,
        remedy: `run: ssh-add ${keyForAdd}  (or disable signing for this repo: git -C ${cwd} config commit.gpgsign false)`,
      };
    }
  }

  return { blocked: false };
}

export { isGitTimeoutError };
