import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CGROOT = "/sys/fs/cgroup";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A POSIX process group is not sufficient containment -- a child can `setsid`
 * and escape it. The real boundary is a Linux cgroup v2 scope, which no
 * descendant can leave. `systemd-run --user --scope` gives us one per attempt.
 *
 * Linux-only. That is a deliberate trade (docs/00-decisions.md D25 / round 4):
 * portability is worth less than a containment guarantee that actually holds.
 */
export class Guardian {
  private constructor(
    public readonly unitName: string,
    public readonly cgroupPath: string, // absolute path under /sys/fs/cgroup
    public readonly childPid: number,
    private watchdogPid: number | undefined,
    public readonly heartbeatFile: string,
  ) {}

  static async launch(
    command: string,
    args: string[],
    opts: { cwd: string; unitName: string; env?: NodeJS.ProcessEnv; heartbeatFile: string; heartbeatStaleMs?: number },
  ): Promise<Guardian> {
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

    let relPath = "";
    const readinessDeadline = Date.now() + 5000;
    while (Date.now() < readinessDeadline) {
      const activeState = (
        await execFileAsync("systemctl", ["--user", "show", `${unitName}.scope`, "--property=ActiveState", "--value"]).catch(
          () => ({ stdout: "" }),
        )
      ).stdout.trim();
      if (activeState === "active" || activeState === "activating") {
        relPath = (
          await execFileAsync("systemctl", [
            "--user",
            "show",
            `${unitName}.scope`,
            "--property=ControlGroup",
            "--value",
          ])
        ).stdout.trim();
        if (relPath) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!relPath) {
      throw new Error(`guardian: scope ${unitName} did not become active with a cgroup within 5s`);
    }
    const cgroupPath = path.join(CGROOT, relPath);

    const mainPidStr = (
      await execFileAsync("systemctl", ["--user", "show", `${unitName}.scope`, "--property=MainPID", "--value"])
    ).stdout.trim();
    const childPid = Number(mainPidStr) || 0;

    await writeFile(opts.heartbeatFile, String(Date.now()));

    const watchdog = spawn(
      "node",
      [
        path.join(__dirname, "watchdog.mjs"),
        cgroupPath,
        opts.heartbeatFile,
        String(opts.heartbeatStaleMs ?? 5000),
        `${opts.heartbeatFile}.killed`,
      ],
      { detached: true, stdio: "ignore" },
    );
    watchdog.unref();

    return new Guardian(unitName, cgroupPath, childPid, watchdog.pid, opts.heartbeatFile);
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
    try {
      const procs = await readFile(path.join(this.cgroupPath, "cgroup.procs"), "utf8");
      return procs.trim().length === 0;
    } catch (err: any) {
      // `--collect` removes the transient scope's cgroup once it empties, so
      // "the directory is gone" is itself proof of emptiness, not an error.
      if (err?.code === "ENOENT") return true;
      throw err;
    }
  }

  async freeze(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.freeze"), "1").catch((err: any) => {
      if (err?.code !== "ENOENT") throw err;
    });
  }

  async thaw(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.freeze"), "0").catch((err: any) => {
      if (err?.code !== "ENOENT") throw err;
    });
  }

  /** Kill every process in the boundary, no matter how many times it forked or setsid'd. */
  async killAll(): Promise<void> {
    await writeFile(path.join(this.cgroupPath, "cgroup.kill"), "1").catch((err: any) => {
      if (err?.code !== "ENOENT") throw err;
    });
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
    try {
      await stat(this.cgroupPath);
      return false;
    } catch {
      return true;
    }
  }

  /** Full teardown: freeze, kill, confirm empty, stop the systemd unit. */
  async quiesce(timeoutMs = 3000): Promise<{ wasEmpty: boolean }> {
    if (await this.cgroupGone()) return { wasEmpty: true };
    await this.freeze();
    await this.killAll();
    // cgroup.kill sends SIGKILL to everything atomically, including frozen
    // and forked/setsid descendants -- freezing first stops new forks from
    // dodging the signal in the gap between listing and killing.
    const empty = await this.waitForEmpty(timeoutMs);
    if (!(await this.cgroupGone())) {
      await execFileAsync("systemctl", ["--user", "stop", `${this.unitName}.scope`]).catch(() => undefined);
    }
    return { wasEmpty: empty };
  }
}
