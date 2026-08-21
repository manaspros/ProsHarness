import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Guardian } from "../src/guardian.js";
import { FIXTURE_PATH, makeRunDir, cleanupDir, uniqueUnitSuffix, killUnitsMatching, waitFor, sleep } from "./helpers.js";

const execFileAsync = promisify(execFile);

/**
 * The fixture namespaces its grandchild marker by FORKING_CHILD_RUN_ID (see
 * forking-child.ts). Without this, a `pgrep -f` for a fixed marker string
 * would also match any escaped grandchild genuinely orphaned by an earlier,
 * unrelated test run on this same dev machine -- darwin has no cgroup to
 * eventually garbage-collect those, so they can persist indefinitely and
 * would otherwise poison every later "no survivors" assertion.
 */
function escapeMarkerFor(runId: string): string {
  return `PROS_ESCAPE_GRANDCHILD:${runId}`;
}

/** Number of live processes anywhere on the box whose command line matches `pattern`. */
async function pgrepCount(pattern: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    return stdout.trim().length === 0 ? 0 : stdout.trim().split("\n").length;
  } catch {
    return 0; // pgrep exits non-zero when nothing matches
  }
}

/** First live pid anywhere on the box whose command line matches `pattern`, or undefined if none. */
async function pgrepFirst(pattern: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    const first = stdout.trim().split("\n")[0];
    return first ? Number(first) : undefined;
  } catch {
    return undefined; // pgrep exits non-zero when nothing matches
  }
}

async function pgidOf(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
  return stdout.trim();
}

// These tests all go through Guardian's public API, which picks the Linux
// cgroup backend or the darwin PID-tree backend once at module load based on
// process.platform (see guardian.ts) -- so the same test genuinely exercises
// whichever backend the host actually has, rather than needing a parallel
// Linux/darwin copy of every scenario. Platform-specific assertions (proving
// *why* darwin's containment worked, and measuring its one real weakness)
// are added inline below, gated on process.platform, plus one darwin-only
// test that has no Linux analog.

test("guardian: kill-test #3 - containment kills an escaping setsid/SIGTERM-ignoring child", async (t) => {
  const runDir = await makeRunDir();
  const unitName = `pros-kt3-${uniqueUnitSuffix()}`;
  const escapeMarker = escapeMarkerFor(unitName);
  try {
    const guardian = await Guardian.launch("node", [FIXTURE_PATH], {
      cwd: runDir,
      unitName,
      heartbeatFile: path.join(runDir, "hb"),
      env: { ...process.env, FORKING_CHILD_MODE: "escape", FORKING_CHILD_RUN_ID: unitName },
    });

    // Give the fixture a moment to fork its detached grandchild and print readiness.
    await sleep(300);
    assert.equal(await guardian.isEmpty(), false, "the boundary should contain live processes before quiesce");

    if (process.platform === "darwin") {
      // Prove *why* the escapee is about to die: it must already be
      // unreachable by a plain process-group signal (kill(-pgid)), because
      // setsid gave it its own process group distinct from the launched
      // process's. If that were not true, this test would not actually
      // distinguish "the PID-tree walk caught it" from "a group signal
      // happened to reach it anyway" -- the two are supposed to be
      // different claims, and DarwinProcessGroupBackend never sends a
      // group signal at all, only per-PID ones to a walked set.
      let grandchildPid = 0;
      await waitFor(async () => {
        const found = await pgrepFirst(escapeMarker);
        if (found === undefined) return false;
        grandchildPid = found;
        return true;
      }, 2000);
      assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, "expected to find the escaping grandchild's pid before quiesce");
      const [launchedPgid, grandchildPgid] = await Promise.all([pgidOf(guardian.childPid), pgidOf(grandchildPid)]);
      assert.notEqual(
        grandchildPgid,
        launchedPgid,
        "the grandchild must have escaped into its own process group, otherwise its death here would not prove PID-tree containment works",
      );
    }

    const { wasEmpty } = await guardian.quiesce(4000);
    assert.equal(wasEmpty, true, "the boundary must be empty after quiesce even though the child ignored SIGTERM and setsid'd a grandchild");

    // Double-check with the real world. FIXTURE_PATH only appears in the
    // parent's own argv (`node <fixture path>`) -- the escaping grandchild's
    // argv is a `-e` inline script carrying the run-scoped escape marker
    // instead, so both must be checked to actually confirm the grandchild
    // (not just the parent) is gone. Matching FIXTURE_PATH alone would only
    // ever prove the parent died -- the actual claim under test is about the
    // grandchild, which is why the marker check (not the path check) is the
    // one that matters.
    const stillAlive = await waitFor(async () => {
      const parentSurvivors = await pgrepCount(FIXTURE_PATH);
      const grandchildSurvivors = await pgrepCount(escapeMarker);
      return parentSurvivors === 0 && grandchildSurvivors === 0;
    }, 2000);
    assert.equal(stillAlive, true, "no descendant of the escaping fixture may survive containment");
  } finally {
    await killUnitsMatching(unitName);
    await cleanupDir(runDir);
  }
});

test("guardian: freeze() actually stops the boundary's processes from making progress", async (t) => {
  const runDir = await makeRunDir();
  const unitName = `pros-freeze-${uniqueUnitSuffix()}`;
  const counterFile = path.join(runDir, "counter");
  try {
    const guardian = await Guardian.launch(
      "node",
      ["-e", `const fs=require('fs'); let i=0; setInterval(()=>{ i++; fs.writeFileSync(${JSON.stringify(counterFile)}, String(i)); }, 20);`],
      { cwd: runDir, unitName, heartbeatFile: path.join(runDir, "hb") },
    );
    await sleep(200);
    await guardian.freeze();
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(counterFile, "utf8").catch(() => "0");
    await sleep(300);
    const after = await readFile(counterFile, "utf8").catch(() => "0");
    // This scenario -- a single, non-forking process -- is one darwin's
    // SIGSTOP-based freeze() genuinely handles at full strength: the "new
    // forks unpaused" gap in the parity table only bites when something
    // forks *after* the freeze snapshot, which nothing here does. So this
    // assertion is not weakened for darwin.
    assert.equal(before, after, "a frozen boundary must not make progress");
    await guardian.quiesce();
  } finally {
    await killUnitsMatching(unitName);
    await cleanupDir(runDir);
  }
});

test("guardian: kill-test #2 - watchdog fails closed when the daemon stops heartbeating", async (t) => {
  const runDir = await makeRunDir();
  const unitName = `pros-kt2-${uniqueUnitSuffix()}`;
  const heartbeatFile = path.join(runDir, "hb");
  try {
    const guardian = await Guardian.launch("node", [FIXTURE_PATH], {
      cwd: runDir,
      unitName,
      heartbeatFile,
      heartbeatStaleMs: 300,
      env: { ...process.env, FORKING_CHILD_MODE: "escape" },
    });
    assert.equal(await guardian.isEmpty(), false);

    // Simulate the daemon dying: just stop heartbeating (do NOT call quiesce()).
    // The detached watchdog process must notice staleness on its own and kill
    // the boundary -- recovery must find nothing left running, and must not
    // race a second attempt against it.
    const killedMarker = `${heartbeatFile}.killed`;
    const killed = await waitFor(async () => {
      const { stat } = await import("node:fs/promises");
      return stat(killedMarker)
        .then(() => true)
        .catch(() => false);
    }, 5000);
    assert.equal(killed, true, "the watchdog must independently detect a stale heartbeat and kill the boundary");
    assert.equal(await guardian.isEmpty(), true, "boundary must be empty after the watchdog's fail-closed kill");
  } finally {
    await killUnitsMatching(unitName);
    await cleanupDir(runDir);
  }
});

async function launchEscapeLoop(label: string) {
  const runDir = await makeRunDir();
  const unitName = `pros-race-${label}-${uniqueUnitSuffix()}`;
  const escapeMarker = escapeMarkerFor(unitName);
  const guardian = await Guardian.launch("node", [FIXTURE_PATH], {
    cwd: runDir,
    unitName,
    heartbeatFile: path.join(runDir, "hb"),
    env: {
      ...process.env,
      FORKING_CHILD_MODE: "escape-loop",
      FORKING_CHILD_FORK_INTERVAL_MS: "20",
      FORKING_CHILD_RUN_ID: unitName,
    },
  });
  await sleep(300); // let the fixture accumulate a population while still actively forking
  return { guardian, unitName, runDir, escapeMarker };
}

// A generous upper bound, not a target: this backend cannot close the fork
// race (see killPidTree in guardian-darwin.ts), only bound it. A well-behaved
// attempt stops scheduling new children the instant its root is killed, so
// the leak this test measures is capped at whatever the fixture's own
// FORKING_CHILD_FORK_INTERVAL_MS managed to queue in the single
// snapshot-to-SIGKILL gap -- observed at 0-1 survivors while writing this
// (see docs/00-decisions.md for the measured numbers). A run that exceeds
// this bound is a real regression to investigate, not expected flake.
const RACE_WINDOW_SURVIVOR_BOUND = 3;

test(
  "guardian(darwin): kill-loop race window under continuous forking",
  { skip: process.platform !== "darwin" ? "darwin-only: measures the snapshot-and-kill loop's fork race, which only exists because darwin has no atomic cgroup.kill" : false },
  async (t) => {
    const { guardian, unitName, runDir, escapeMarker } = await launchEscapeLoop("race");
    try {
      const populationBeforeKill = await pgrepCount(escapeMarker);
      assert.ok(populationBeforeKill > 0, "expected the escape-loop fixture to have forked at least one grandchild by now");

      // The real production path: freeze -> killAll -> waitForEmpty, against
      // a fixture that keeps forking a new escaping grandchild every 20ms
      // for as long as its root survives.
      const convergeStart = Date.now();
      await guardian.quiesce(4000);
      const convergeMs = Date.now() - convergeStart;

      // A straggler forked in the last snapshot-to-signal gap re-parents to
      // launchd and may take a beat to actually terminate under SIGKILL;
      // give it one before counting survivors.
      await sleep(100);
      const survivors = await pgrepCount(escapeMarker);

      // eslint-disable-next-line no-console
      console.log(
        `[race-window] population before kill: ${populationBeforeKill}, convergence: ${convergeMs}ms, survivors after quiesce: ${survivors}`,
      );

      assert.ok(
        survivors <= RACE_WINDOW_SURVIVOR_BOUND,
        `expected at most ${RACE_WINDOW_SURVIVOR_BOUND} straggler(s) from the irreducible fork race, got ${survivors}`,
      );

      // Best-effort cleanup of any straggler -- genuinely orphaned (ppid 1),
      // so nothing will ever reap it on its own. Test hygiene, not part of
      // the measurement.
      if (survivors > 0) {
        await execFileAsync("pkill", ["-9", "-f", escapeMarker]).catch(() => undefined);
      }
    } finally {
      await killUnitsMatching(unitName);
      await cleanupDir(runDir);
    }
  },
);
