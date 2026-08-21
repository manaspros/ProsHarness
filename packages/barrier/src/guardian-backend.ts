/**
 * The platform-specific half of process containment.
 *
 * `Guardian` (guardian.ts) is the public API and the platform-agnostic
 * dispatcher: it owns the launch-retry loop, heartbeat bookkeeping, and
 * `quiesce()`'s freeze/kill/wait sequencing. Everything that actually
 * touches the OS's containment primitive -- a Linux cgroup v2 scope vs. a
 * walked-and-signalled PID tree on darwin -- lives behind this interface in
 * `guardian-linux.ts` / `guardian-darwin.ts`.
 *
 * This shape is not invented: it is the pre-split `Guardian` class's own
 * public instance surface (isEmpty/freeze/thaw/killAll/cgroupGone), factored
 * out so two implementations can sit behind one dispatcher chosen once at
 * module load (see guardian.ts). `cgroupGone` keeps its Linux-flavored name
 * across both backends deliberately -- renaming it buys nothing and would
 * touch call sites for no behavioral change; darwin's implementation just
 * documents what "gone" means for a PID tree instead of a cgroup directory.
 */
export interface GuardianBackend {
  /**
   * Best-effort PID of the directly-launched process. 0 where the launch
   * mechanism does not expose one (a systemd `.scope` unit never populates
   * MainPID). Nothing in this codebase reads it today; kept for parity with
   * the pre-split Guardian and because it is useful for debugging.
   */
  readonly childPid: number;

  /** True if the boundary currently contains no live process. */
  isEmpty(): Promise<boolean>;

  /** Stop every contained process from making progress without killing it. */
  freeze(): Promise<void>;

  /** Reverse freeze(). */
  thaw(): Promise<void>;

  /** Kill every process in the boundary, no matter how many times it forked or setsid'd. */
  killAll(): Promise<void>;

  /** True once the boundary itself is gone, not merely empty (a Linux cgroup directory can outlive its last member briefly; on darwin there is no such directory, so this is equivalent to isEmpty()). */
  cgroupGone(): Promise<boolean>;

  /** Best-effort cleanup of any platform-side registration (a systemd unit) once the boundary is confirmed empty or gone. A no-op where there is nothing to clean up. */
  teardown(): Promise<void>;
}

export interface GuardianLaunchOpts {
  cwd: string;
  unitName: string;
  env?: NodeJS.ProcessEnv;
  heartbeatFile: string;
  heartbeatStaleMs?: number;
}

/** What a backend's attemptLaunch returns: the containment handle plus the watchdog process it spawned (for logging/debugging; nothing reads it today). */
export interface GuardianBackendHandle {
  backend: GuardianBackend;
  watchdogPid: number | undefined;
}
