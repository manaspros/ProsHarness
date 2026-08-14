/**
 * A deliberately escaping process, for proving containment against something
 * that actively tries to get away rather than a well-behaved model. A
 * compliant agent proves nothing about an escaping one.
 *
 * Behavior, controlled by env vars so the same fixture drives every kill-test
 * that needs an adversarial child:
 *
 *   FORKING_CHILD_MODE=escape (default)
 *     Ignores SIGTERM. Immediately double-forks a detached grandchild via
 *     `setsid`, which itself also ignores SIGTERM and keeps running, holding
 *     stdout open. Only SIGKILL (which cgroup.kill sends) can end it -- proof
 *     that a process group signal alone is not containment.
 *
 *   FORKING_CHILD_MODE=sentinel
 *     After FORKING_CHILD_DELAY_MS (default 200), writes FORKING_CHILD_SENTINEL
 *     to disk. Used to prove the barrier stopped a write attempted after a
 *     checkpoint was requested (kill-test #1) -- the process is killed before
 *     the delay elapses if containment works.
 *
 * Both modes print a line to stdout the moment they're ready, so a test
 * harness can synchronize without a fixed sleep.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  // Deliberately ignored.
});

const mode = process.env.FORKING_CHILD_MODE ?? "escape";

if (mode === "escape") {
  // setsid detaches the grandchild into its own session -- the classic
  // process-group escape. It survives on cgroup membership alone, which is
  // exactly what the cgroup v2 boundary (not a process-group signal) exists
  // to still catch.
  const grandchild = spawn(
    "setsid",
    ["node", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" },
  );
  grandchild.unref();
  console.log("escape-child-ready");
  setInterval(() => {
    // Keep the parent alive too, and also ignoring SIGTERM.
  }, 1000);
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
