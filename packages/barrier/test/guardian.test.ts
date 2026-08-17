import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Guardian } from "../src/guardian.js";
import { FIXTURE_PATH, makeRunDir, cleanupDir, uniqueUnitSuffix, killUnitsMatching, waitFor, sleep } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("guardian: kill-test #3 - containment kills an escaping setsid/SIGTERM-ignoring child", async (t) => {
  const runDir = await makeRunDir();
  const unitName = `pros-kt3-${uniqueUnitSuffix()}`;
  try {
    const guardian = await Guardian.launch("node", [FIXTURE_PATH], {
      cwd: runDir,
      unitName,
      heartbeatFile: path.join(runDir, "hb"),
      env: { ...process.env, FORKING_CHILD_MODE: "escape" },
    });

    // Give the fixture a moment to fork its detached grandchild and print readiness.
    await sleep(300);
    assert.equal(await guardian.isEmpty(), false, "the boundary should contain live processes before quiesce");

    const { wasEmpty } = await guardian.quiesce(4000);
    assert.equal(wasEmpty, true, "the boundary must be empty after quiesce even though the child ignored SIGTERM and setsid'd a grandchild");

    // Double-check with the real world: no stray node processes referencing this fixture remain.
    const stillAlive = await waitFor(async () => {
      try {
        const { stdout } = await execFileAsync("pgrep", ["-f", FIXTURE_PATH]);
        return stdout.trim().length === 0;
      } catch {
        return true; // pgrep exits non-zero when nothing matches
      }
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
    assert.equal(before, after, "a frozen cgroup must not make progress");
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
