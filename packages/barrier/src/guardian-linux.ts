import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardianBackend, GuardianBackendHandle, GuardianLaunchOpts } from "./guardian-backend.js";

const execFileAsync = promisify(execFile);
const CGROOT = "/sys/fs/cgroup";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A cgroupfs operation on a boundary that's being torn down out from under
 * us can fail with either ENOENT (directory already gone) or ENODEV (the
 * kernel severed the cgroup's device association mid-operation, observed in
 * practice on this codebase's own test suite) -- both mean exactly the same
 * thing ("this cgroup no longer exists"), so both must be treated the same
 * way everywhere this codebase checks for it.
 */
function isCgroupGoneError(err: any): boolean {
  return err?.code === "ENOENT" || err?.code === "ENODEV";
}

/**
 * A POSIX process group is not sufficient containment -- a child can `setsid`
 * and escape it. The real boundary is a Linux cgroup v2 scope, which no
 * descendant can leave. `systemd-run --user --scope` gives us one per attempt.
 *
 * Linux-only. That is a deliberate trade (docs/00-decisions.md D25 / round 4):
 * portability is worth less than a containment guarantee that actually holds.
 * See docs/00-decisions.md (darwin backend entry) for the macOS analog and
 * exactly where its guarantee is weaker.
 */
class LinuxCgroupBackend implements GuardianBackend {
  readonly childPid = 0;

  constructor(
    private readonly unitName: string,
    private readonly cgroupPath: string, // absolute path under /sys/fs/cgroup
  ) {}

  async isEmpty(): Promise<boolean> {
    try {
      const procs = await readFile(path.join(this.cgroupPath, "cgroup.procs"), "utf8");
      return procs.trim().length === 0;
    } catch (err: any) {
      // `--collect` removes the transient scope's cgroup once it empties, so
      // "the directory is gone" is itself proof of emptiness, not an error.
      // A cgroup being removed *during* the read (a real, reproduced race:
      // the file exists at open() time but the kernel tears down the
      // cgroup's association before the read completes) surfaces as ENODEV,
      // not ENOENT -- same fact ("it's gone"), different errno, so both must
      // be treated as empty.
      if (isCgroupGoneError(err)) return true;
      throw err;
    }
  }

  async freeze(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.freeze"), "1").catch((err: any) => {
      if (!isCgroupGoneError(err)) throw err;
    });
  }

  async thaw(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.freeze"), "0").catch((err: any) => {
      if (!isCgroupGoneError(err)) throw err;
    });
  }

  /** Kill every process in the boundary, no matter how many times it forked or setsid'd. */
  async killAll(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.kill"), "1").catch((err: any) => {
      if (!isCgroupGoneError(err)) throw err;
    });
  }

  async cgroupGone(): Promise<boolean> {
    try {
      await stat(this.cgroupPath);
      return false;
    } catch {
      return true;
    }
  }

  async teardown(): Promise<void> {
    await execFileAsync("systemctl", ["--user", "stop", `${this.unitName}.scope`]).catch(() => undefined);
  }
}

export async function attemptLaunchLinux(
  command: string,
  args: string[],
  opts: GuardianLaunchOpts,
): Promise<GuardianBackendHandle> {
  const unitName = opts.unitName;

  // `systemd-run --scope` creates the transient scope AND remains attached
  // as its supervising process for the command's entire lifetime -- it
  // does NOT return once the scope is merely registered. So we must not
  // await its exit here (the attempt may run indefinitely); instead we
  // spawn it in the background and poll systemd for the scope becoming
  // active, which is the actual readiness signal.
  //
  // stdio is fully ignored, not piped: an unconsumed pipe backpressures
  // the OS pipe buffer once the attempt writes enough output, and would
  // silently wedge a long-running attempt.
  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--collect",
      `--unit=${unitName}`,
      "-p",
      "Description=pros-attempt",
      "--",
      command,
      ...args,
    ],
    {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "ignore",
      detached: true,
    },
  );
  child.unref();
  child.once("error", (err) => {
    // Nothing awaits this directly; surface loudly rather than swallow,
    // since a failed spawn here means containment never existed.
    // eslint-disable-next-line no-console
    console.error(`guardian: systemd-run spawn error for ${unitName}:`, err);
  });

  // NOTE: `MainPID` is a `.service`-only systemd property -- a `.scope`
  // unit (what we create here) never populates it. An earlier version of
  // this fix tried to gate readiness on MainPID > 0 for a scope and, since
  // that property is simply never set for scopes, it always timed out.
  // childPid stays best-effort/0 for scopes; nothing in this codebase
  // relies on it (grep confirms `.childPid` has no readers), so that is
  // not a regression -- just worth naming so nobody tries the same fix
  // twice.
  let relPath = "";
  const readinessDeadline = Date.now() + 5000;
  while (Date.now() < readinessDeadline) {
    const props = (
      await execFileAsync("systemctl", [
        "--user",
        "show",
        `${unitName}.scope`,
        "--property=ActiveState",
        "--property=ControlGroup",
      ]).catch(() => ({ stdout: "" }))
    ).stdout;
    const activeState = /^ActiveState=(.*)$/m.exec(props)?.[1]?.trim() ?? "";
    const relPathCandidate = /^ControlGroup=(.*)$/m.exec(props)?.[1]?.trim() ?? "";
    // The bug this closes: the original code declared the scope "ready"
    // the moment ActiveState read active/activating and ControlGroup was
    // non-empty -- both of which a transient scope can report *after it
    // has already died* under back-to-back systemd-run churn (confirmed
    // by direct reproduction: ActiveState=active with a real ControlGroup
    // path, cgroup.procs already ENOENT, zero bytes of the target
    // command's output ever produced). ActiveState/ControlGroup are
    // systemd's self-reported bookkeeping; cgroup.procs is the kernel's
    // own membership list for that exact path and cannot be stale in the
    // same way -- so readiness now requires a real, currently-live PID
    // actually sitting in the cgroup, not just systemd's say-so that the
    // unit exists.
    if (activeState === "active" || activeState === "activating") {
      if (relPathCandidate) {
        const candidatePath = path.join(CGROOT, relPathCandidate);
        const hasLiveMember = await readFile(path.join(candidatePath, "cgroup.procs"), "utf8")
          .then((procs) => procs.trim().length > 0)
          .catch(() => false);
        if (hasLiveMember) {
          relPath = relPathCandidate;
          break;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!relPath) {
    throw new Error(`guardian: scope ${unitName} never had a live process join its cgroup within 5s`);
  }
  const cgroupPath = path.join(CGROOT, relPath);

  await writeFile(opts.heartbeatFile, String(Date.now()));

  const watchdog = spawn(
    "node",
    [
      path.join(__dirname, "watchdog.mjs"),
      "cgroup",
      cgroupPath,
      opts.heartbeatFile,
      String(opts.heartbeatStaleMs ?? 5000),
      `${opts.heartbeatFile}.killed`,
    ],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();

  return { backend: new LinuxCgroupBackend(unitName, cgroupPath), watchdogPid: watchdog.pid };
}
