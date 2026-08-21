import { writeFile } from "node:fs/promises";
import type { GuardianBackend, GuardianBackendHandle } from "./guardian-backend.js";
import { attemptLaunchLinux } from "./guardian-linux.js";
import { attemptLaunchDarwin } from "./guardian-darwin.js";

/**
 * A POSIX process group is not sufficient containment -- a child can `setsid`
 * and escape it. The real boundary is a Linux cgroup v2 scope, which no
 * descendant can leave.
 *
 * `Guardian` is the platform-agnostic public API: launch-retry loop,
 * heartbeat bookkeeping, and quiesce()'s freeze/kill/wait sequencing. Every
 * containment primitive is delegated to a `GuardianBackend` (guardian-backend.ts)
 * chosen once here, at module load, based on `process.platform` -- not
 * per-call, so a single process never straddles two containment strategies.
 * `guardian-linux.ts` holds the cgroup v2 / systemd-scope implementation
 * (docs/00-decisions.md D25 / round 4: Linux is the strong guarantee, a
 * deliberate trade). `guardian-darwin.ts` holds the PID-tree-walk substitute
 * for the platform most contributors actually develop on, which is real
 * containment but a strictly weaker guarantee -- see the parity table in
 * docs/00-decisions.md.
 */
const attemptLaunch = process.platform === "darwin" ? attemptLaunchDarwin : attemptLaunchLinux;

export class Guardian {
  private constructor(
    public readonly unitName: string,
    private readonly backend: GuardianBackend,
    private watchdogPid: number | undefined,
    public readonly heartbeatFile: string,
  ) {}

  static async launch(
    command: string,
    args: string[],
    opts: { cwd: string; unitName: string; env?: NodeJS.ProcessEnv; heartbeatFile: string; heartbeatStaleMs?: number },
  ): Promise<Guardian> {
    // This outer retry is defense in depth for the rare case where the
    // chosen backend's own readiness check never succeeds within its
    // deadline -- e.g. genuine host overload -- so one launch failure isn't
    // necessarily final. Each retry uses a fresh unit name; on Linux
    // `--collect` means a scope that never had a live member and went
    // inactive on its own needs no explicit cleanup from us, and on darwin
    // there is nothing to clean up beyond the process itself.
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const unitName = attempt === 1 ? opts.unitName : `${opts.unitName}-r${attempt}`;
      try {
        const handle: GuardianBackendHandle = await attemptLaunch(command, args, { ...opts, unitName });
        return new Guardian(unitName, handle.backend, handle.watchdogPid, opts.heartbeatFile);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`guardian: failed to launch ${opts.unitName} after ${maxAttempts} attempts`);
  }

  get childPid(): number {
    return this.backend.childPid;
  }

  async heartbeat(): Promise<void> {
    await writeFile(this.heartbeatFile, String(Date.now()));
  }

  stopHeartbeat(): void {
    // Deliberately no-op: callers stop calling heartbeat(); the watchdog's
    // own staleness check is what fails the attempt closed if the daemon
    // vanishes without an orderly shutdown.
  }

  async isEmpty(): Promise<boolean> {
    return this.backend.isEmpty();
  }

  async freeze(): Promise<void> {
    await this.backend.freeze();
  }

  async thaw(): Promise<void> {
    await this.backend.thaw();
  }

  /** Kill every process in the boundary, no matter how many times it forked or setsid'd. */
  async killAll(): Promise<void> {
    await this.backend.killAll();
  }

  async waitForEmpty(timeoutMs: number, pollMs = 25): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isEmpty()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return this.isEmpty();
  }

  async cgroupGone(): Promise<boolean> {
    return this.backend.cgroupGone();
  }

  /** Full teardown: freeze, kill, confirm empty, tear down any platform-side registration. */
  async quiesce(timeoutMs = 3000): Promise<{ wasEmpty: boolean }> {
    if (await this.cgroupGone()) return { wasEmpty: true };
    await this.freeze();
    await this.killAll();
    // On Linux, cgroup.kill sends SIGKILL to everything atomically,
    // including frozen and forked/setsid descendants -- freezing first
    // stops new forks from dodging the signal in the gap between listing
    // and killing. On darwin, killAll() itself loops snapshot+SIGKILL for
    // the same reason, since there is no atomic equivalent; freezing first
    // still helps by pausing already-discovered processes between rounds.
    const empty = await this.waitForEmpty(timeoutMs);
    if (!(await this.cgroupGone())) {
      await this.backend.teardown();
    }
    return { wasEmpty: empty };
  }
}
