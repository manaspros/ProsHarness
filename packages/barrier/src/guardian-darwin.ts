import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardianBackend, GuardianBackendHandle, GuardianLaunchOpts } from "./guardian-backend.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * darwin has no cgroup v2 equivalent: no kernel-enforced closed set that a
 * `setsid`'d descendant cannot leave, and no atomic "kill everything in this
 * set" syscall. What follows is the best available substitute -- a PID-tree
 * walk rooted at the launched process, repeated over a short window to
 * narrow (never close) the fork race -- and it is honestly weaker than the
 * Linux backend on every axis except orphan reaping. See docs/00-decisions.md
 * for the full parity table and the two rejected alternatives (sandbox-exec,
 * macOS App Sandbox).
 *
 * Concretely, two gaps that have no fix short of a kernel-level primitive
 * macOS does not expose to unprivileged processes:
 *  - Fork race: a descendant can fork a new child in the gap between one
 *    snapshot and the SIGKILLs that snapshot produces. Looping narrows this
 *    window; it cannot close it.
 *  - PID reuse: between snapshotting a PID and signalling it, that PID could
 *    in principle have been reaped and reassigned to an unrelated process by
 *    the kernel. On a normal-load dev machine within the tens-of-milliseconds
 *    loop interval used here this is not observed, but it is not ruled out.
 *
 * A third hazard is avoidable, and this backend avoids it: if the launched
 * process (childPid) dies before its own escaped descendants do -- likely,
 * since it is usually the first thing discovered and signalled -- the
 * kernel immediately re-parents any still-living descendant to launchd
 * (ppid 1). A naive "walk descendants of childPid via the current ppid map"
 * check, run again after that happens, finds nothing: childPid itself is
 * gone, so there is no root left to walk from, and the re-parented survivor
 * is no longer reachable by ppid chase even though it is still very much
 * alive. That reads as "boundary empty" when it is not -- a false-negative
 * that would defeat the whole point of this backend. The fix is `known`: a
 * per-boundary set of every PID ever confirmed to descend from childPid,
 * which is only ever added to, never recomputed from scratch and never
 * pruned just because its immediate parent died. See
 * `aliveKnownDescendants` below and docs/00-decisions.md for how this was
 * actually caught (a real, reproduced test failure, not a hypothetical).
 */
class DarwinProcessGroupBackend implements GuardianBackend {
  // Every PID ever confirmed to descend from childPid, for the lifetime of
  // this backend instance. This set only grows, never shrinks -- see
  // `aliveKnownDescendants` for why forgetting a dead member is exactly the
  // re-parent-to-launchd bug this backend has to avoid.
  private readonly known: Set<number>;

  constructor(readonly childPid: number) {
    this.known = new Set([childPid]);
  }

  async isEmpty(): Promise<boolean> {
    return (await aliveKnownDescendants(this.known)).length === 0;
  }

  async freeze(): Promise<void> {
    // Snapshot once and signal that snapshot -- a descendant forked after
    // the snapshot is taken will not be paused. That is the "new forks
    // unpaused" gap in the parity table; cgroup.freeze has no such gap
    // because the kernel freezes the whole cgroup membership atomically.
    const pids = await aliveKnownDescendants(this.known);
    for (const pid of pids) signalIgnoreMissing(pid, "SIGSTOP");
  }

  async thaw(): Promise<void> {
    const pids = await aliveKnownDescendants(this.known);
    for (const pid of pids) signalIgnoreMissing(pid, "SIGCONT");
  }

  async killAll(): Promise<void> {
    await killPidTree(this.known);
  }

  async cgroupGone(): Promise<boolean> {
    // No directory to outlive its last member here, unlike a Linux cgroup
    // -- once the tree has no live PID left, the boundary is gone.
    return this.isEmpty();
  }

  async teardown(): Promise<void> {
    // Nothing was registered with the OS beyond the process itself (no
    // systemd-equivalent unit exists to stop).
  }
}

interface ProcRow {
  pid: number;
  ppid: number;
  zombie: boolean;
}

/** One `ps` snapshot of every process on the system, parsed into pid/ppid/state. */
async function snapshotAll(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,stat="]);
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidStr, ppidStr, stat] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    // A zombie (stat starts with 'Z') has already exited and is only
    // waiting for its parent to reap it -- it cannot spawn descendants and
    // signalling it is a no-op, so it is walked (in case something is
    // waiting on it) but never treated as "alive" or targeted with a signal.
    rows.push({ pid, ppid, zombie: stat.startsWith("Z") });
  }
  return rows;
}

/**
 * Expand `known` in place with every live descendant reachable, by the
 * current ppid map, from any PID already in `known` -- then return the
 * subset of `known` that is currently alive.
 *
 * `known` must be threaded through every call for the same boundary (see
 * DarwinProcessGroupBackend.known) rather than recomputed as "descendants of
 * rootPid" fresh each time. The difference matters the moment rootPid
 * itself dies: a plain rootPid-rooted walk would then find nothing (rootPid
 * is gone, so it is not in the alive set to walk from), silently reporting
 * "empty" even though a live grandchild -- discovered on an earlier call,
 * now re-parented to launchd with ppid 1 -- is still running. `known`
 * remembers that grandchild forever once seen, specifically so a dead root
 * is never mistaken for an empty boundary. This was a real, reproduced bug
 * during this backend's own test suite (see docs/00-decisions.md).
 */
async function aliveKnownDescendants(known: Set<number>): Promise<number[]> {
  const all = await snapshotAll();
  const alive = new Set(all.filter((r) => !r.zombie).map((r) => r.pid));
  const byParent = new Map<number, number[]>();
  for (const row of all) {
    if (row.zombie) continue;
    const siblings = byParent.get(row.ppid) ?? [];
    siblings.push(row.pid);
    byParent.set(row.ppid, siblings);
  }

  // Only expand from currently-alive known members -- a dead one has
  // nothing left to have forked since we last looked, and its ppid slot in
  // this snapshot may since have been reused by an unrelated process.
  const queue = [...known].filter((pid) => alive.has(pid));
  while (queue.length > 0) {
    const pid = queue.pop()!;
    for (const child of byParent.get(pid) ?? []) {
      if (!known.has(child)) {
        known.add(child);
        queue.push(child);
      }
    }
  }

  return [...known].filter((pid) => alive.has(pid));
}

function signalIgnoreMissing(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err: any) {
    // ESRCH: already gone between snapshot and signal -- expected under the
    // fork/exit race this backend cannot fully close, not an error.
    if (err?.code !== "ESRCH") throw err;
  }
}

const KILL_LOOP_MAX_ITERATIONS = 40;
const KILL_LOOP_HARD_DEADLINE_MS = 3000;
const KILL_LOOP_POLL_MS = 25;

/**
 * Repeatedly expand-and-SIGKILL the descendant set tracked by `known` until
 * a pass finds nothing alive, or we hit the iteration/deadline cap.
 *
 * Kill order within a pass does not need to be children-before-parents: a
 * child re-parented to launchd mid-pass is not lost, because
 * `aliveKnownDescendants` remembers every PID it has ever seen in `known`
 * regardless of whether its immediate parent is still alive.
 *
 * An earlier version of this function deliberately held rootPid alive and
 * killed it last, reasoning that anything it forks while still alive still
 * shows up as its child in the next snapshot. That is true, but it is the
 * wrong trade against an adversary that keeps forking for as long as its
 * root is alive (this backend's own test fixture does exactly this): "no
 * other known-alive descendant left" then never becomes true within the
 * budget, so the loop burns its entire deadline and still kills the root at
 * the very last moment anyway -- all cost, no benefit, confirmed by direct
 * measurement while writing this (see docs/00-decisions.md). Killing
 * everything discovered on every pass, root included, is both faster and
 * no worse: once the root dies, a well-behaved attempt stops forking
 * (nothing schedules more children), which is exactly why the residual
 * race window this loop cannot close is bounded to "whatever forked in the
 * last snapshot-to-signal gap," not unbounded.
 *
 * What the loop (as opposed to a single pass) still buys is real and
 * irreducible: it catches a `setsid`'d grandchild forked before our first
 * snapshot, and narrows -- without ever fully closing -- the window for one
 * forked during the loop itself. `known` may be a bare rootPid (wrapped
 * into a fresh set) or a set already shared with isEmpty()/freeze()/thaw()
 * calls on the same boundary, so that a caller measuring "cost of one pass"
 * and a caller doing the real kill agree on what has already been
 * discovered.
 */
export async function killPidTree(
  known: number | Set<number>,
  opts: { maxIterations?: number; deadlineMs?: number } = {},
): Promise<{ iterations: number }> {
  const knownSet = known instanceof Set ? known : new Set([known]);
  const maxIterations = opts.maxIterations ?? KILL_LOOP_MAX_ITERATIONS;
  const deadline = Date.now() + (opts.deadlineMs ?? KILL_LOOP_HARD_DEADLINE_MS);
  let iterations = 0;
  for (; iterations < maxIterations && Date.now() < deadline; iterations++) {
    const pids = await aliveKnownDescendants(knownSet);
    if (pids.length === 0) break;
    for (const pid of pids) signalIgnoreMissing(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, KILL_LOOP_POLL_MS));
  }
  return { iterations };
}

export async function attemptLaunchDarwin(
  command: string,
  args: string[],
  opts: GuardianLaunchOpts,
): Promise<GuardianBackendHandle> {
  // `detached: true` on POSIX calls setsid(2) before exec, making the child
  // its own session/process-group leader. That is strictly weaker than a
  // cgroup (nothing stops a further setsid deeper in the tree, and
  // kill(-pgid) would miss it) but it does mean the launched process itself
  // starts outside our own process group, so a stray signal to our group
  // never reaches it by accident.
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  let spawnErr: unknown;
  child.once("error", (err) => {
    spawnErr = err;
  });

  const childPid = child.pid;
  if (!childPid) {
    throw new Error(`guardian(darwin): spawn of ${command} for ${opts.unitName} returned no pid`);
  }

  // Mirror the Linux backend's rigour in spirit: don't trust the pid the
  // moment spawn() returns it, confirm the process is actually still alive
  // a beat later (catches the "binary not found" / immediate-crash case,
  // which surfaces as an async 'error' event or a fast exit, not a thrown
  // exception from spawn()).
  const readinessDeadline = Date.now() + 1000;
  let confirmedAlive = false;
  while (Date.now() < readinessDeadline) {
    if (spawnErr) throw spawnErr;
    if (isAlive(childPid)) {
      confirmedAlive = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!confirmedAlive) {
    throw new Error(`guardian(darwin): ${command} (pid ${childPid}) for ${opts.unitName} did not stay alive within 1s`);
  }

  await writeFile(opts.heartbeatFile, String(Date.now()));

  const watchdog = spawn(
    "node",
    [
      path.join(__dirname, "watchdog.mjs"),
      "pidtree",
      String(childPid),
      opts.heartbeatFile,
      String(opts.heartbeatStaleMs ?? 5000),
      `${opts.heartbeatFile}.killed`,
    ],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();

  return { backend: new DarwinProcessGroupBackend(childPid), watchdogPid: watchdog.pid };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
