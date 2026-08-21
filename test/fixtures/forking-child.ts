/**
 * A deliberately escaping process, for proving containment against something
 * that actively tries to get away rather than a well-behaved model. A
 * compliant agent proves nothing about an escaping one.
 *
 * Behavior, controlled by env vars so the same fixture drives every kill-test
 * that needs an adversarial child:
 *
 *   FORKING_CHILD_MODE=escape (default)
 *     Ignores SIGTERM. Immediately double-forks a detached grandchild that
 *     also ignores SIGTERM and keeps running, holding stdout open. Only
 *     SIGKILL (which cgroup.kill sends on Linux, or a PID-tree walk finds
 *     and sends on darwin) can end it -- proof that a process group signal
 *     alone is not containment.
 *
 *     The grandchild is spawned with Node's own `detached: true`, which on
 *     POSIX calls setsid(2) before exec -- the same escape mechanism the
 *     external `setsid` binary provides, without depending on a binary that
 *     Linux ships (util-linux) but macOS does not.
 *
 *   FORKING_CHILD_MODE=sentinel
 *     After FORKING_CHILD_DELAY_MS (default 200), writes FORKING_CHILD_SENTINEL
 *     to disk. Used to prove the barrier stopped a write attempted after a
 *     checkpoint was requested (kill-test #1) -- the process is killed before
 *     the delay elapses if containment works.
 *
 *   FORKING_CHILD_MODE=escape-loop
 *     Like escape, but keeps forking a fresh escaping grandchild every
 *     FORKING_CHILD_FORK_INTERVAL_MS (default 20) instead of forking once.
 *     Exists to give the darwin backend's snapshot-and-kill loop something
 *     to race against, so the race window it cannot fully close has an
 *     actual adversary to measure it with, rather than being asserted only
 *     in a code comment.
 *
 * All grandchildren (escape and escape-loop) are spawned with a marker
 * string in their argv, namespaced by FORKING_CHILD_RUN_ID (default
 * "default"), so a test harness can `pgrep -f` for exactly its own
 * grandchild population -- not this parent process (whose own argv is just
 * this file's path), and not another test's or another run's genuinely
 * orphaned leftovers, which on darwin have no cgroup to eventually reap them.
 *
 * Every mode prints a line to stdout the moment it's ready, so a test
 * harness can synchronize without a fixed sleep.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  // Deliberately ignored.
});

const mode = process.env.FORKING_CHILD_MODE ?? "escape";

// Every marker is namespaced with FORKING_CHILD_RUN_ID (the caller's own
// unique unit name, by convention) rather than a fixed string. A darwin
// test that dies mid-run (or an earlier failed run on this same dev
// machine) can leave a genuinely orphaned escaped grandchild behind
// forever -- there is no cgroup to garbage-collect it. A test that then
// `pgrep -f`s a fixed marker would silently count that unrelated leftover
// as "still alive" and either false-fail or mask a real regression. A
// per-run marker means each test can only ever see its own descendants.
const runId = process.env.FORKING_CHILD_RUN_ID ?? "default";
const ESCAPE_GRANDCHILD_MARKER = `PROS_ESCAPE_GRANDCHILD:${runId}`;

// Node's own `detached: true` calls setsid(2) before exec on POSIX -- the
// same session-escape mechanism the external `setsid` binary provides,
// without depending on a binary Linux ships (util-linux) but macOS does
// not. Each grandchild survives on cgroup membership alone on Linux, and on
// a PID-tree walk alone on darwin -- which is exactly what each platform's
// boundary (not a process-group signal) exists to still catch.
function spawnEscapingGrandchild(): void {
  const grandchild = spawn(
    process.execPath,
    ["-e", `/*${ESCAPE_GRANDCHILD_MARKER}*/ process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`],
    { detached: true, stdio: "ignore" },
  );
  grandchild.unref();
}

if (mode === "escape") {
  spawnEscapingGrandchild();
  console.log("escape-child-ready");
  setInterval(() => {
    // Keep the parent alive too, and also ignoring SIGTERM.
  }, 1000);
} else if (mode === "escape-loop") {
  const intervalMs = Number(process.env.FORKING_CHILD_FORK_INTERVAL_MS ?? "20");
  spawnEscapingGrandchild();
  console.log("escape-child-ready");
  setInterval(spawnEscapingGrandchild, intervalMs);
} else if (mode === "sentinel") {
  const delay = Number(process.env.FORKING_CHILD_DELAY_MS ?? "200");
  const sentinelPath = process.env.FORKING_CHILD_SENTINEL ?? "./sentinel.txt";
  console.log("sentinel-child-ready");
  setTimeout(() => {
    try {
      writeFileSync(sentinelPath, "written by forking-child despite checkpoint");
    } catch {
      // Killed before this ran, which is the whole point.
    }
  }, delay);
  setInterval(() => {}, 1000);
} else {
  throw new Error(`unknown FORKING_CHILD_MODE: ${mode}`);
}
