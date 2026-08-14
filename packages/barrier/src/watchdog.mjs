#!/usr/bin/env node
// Standalone fail-closed watchdog. Spawned detached so it outlives the daemon
// process that started it -- if the daemon dies without an orderly shutdown,
// this is what freezes and kills the attempt's cgroup instead of leaving it
// running unsupervised. Deliberately plain JS (no build step) so it can be
// spawned directly by path with no compile/loader dependency.
//
// argv: <cgroupAbsPath> <heartbeatFile> <staleMs> <markerFile>

import { readFile, writeFile, stat } from "node:fs/promises";

const [, , cgroupPath, heartbeatFile, staleMsStr, markerFile] = process.argv;
const staleMs = Number(staleMsStr);

async function cgroupGone() {
  try {
    await stat(cgroupPath);
    return false;
  } catch {
    return true;
  }
}

async function heartbeatAge() {
  try {
    const raw = await readFile(heartbeatFile, "utf8");
    const last = Number(raw.trim());
    if (!Number.isFinite(last)) return Infinity;
    return Date.now() - last;
  } catch {
    // No heartbeat file at all is treated as immediately stale -- fail closed.
    return Infinity;
  }
}

async function isEmpty() {
  try {
    const procs = await readFile(`${cgroupPath}/cgroup.procs`, "utf8");
    return procs.trim().length === 0;
  } catch {
    return true;
  }
}

async function killBoundary() {
  try {
    await writeFile(`${cgroupPath}/cgroup.freeze`, "1");
  } catch {
    /* cgroup may already be gone */
  }
  try {
    await writeFile(`${cgroupPath}/cgroup.kill`, "1");
  } catch {
    /* cgroup may already be gone */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await isEmpty()) || (await cgroupGone())) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await writeFile(markerFile, String(Date.now())).catch(() => undefined);
}

async function main() {
  while (true) {
    if (await cgroupGone()) {
      // Attempt already tore down cleanly (normal quiesce path) -- nothing to do.
      process.exit(0);
    }
    const age = await heartbeatAge();
    if (age > staleMs) {
      await killBoundary();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, Math.min(250, staleMs / 4)));
  }
}

main();
