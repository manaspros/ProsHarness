#!/usr/bin/env node
// Standalone fail-closed watchdog. Spawned detached so it outlives the daemon
// process that started it -- if the daemon dies without an orderly shutdown,
// this is what freezes and kills the attempt's boundary instead of leaving it
// running unsupervised. Deliberately plain JS (no build step) so it can be
// spawned directly by path with no compile/loader dependency.
//
// argv: <mode: "cgroup"|"pidtree"> <boundaryArg> <heartbeatFile> <staleMs> <markerFile>
//   mode=cgroup:   boundaryArg is the absolute cgroup path (Linux).
//   mode=pidtree:  boundaryArg is the root PID of the launched process (darwin).
//
// The poll loop in main() is not mode-specific -- it never was. What differs
// between platforms is what "the boundary is gone" and "kill the boundary"
// mean, so only isEmpty/boundaryGone/killBoundary branch on mode.
//
// The pidtree branch below duplicates aliveKnownDescendants/killPidTree from
// guardian-darwin.ts (including the persistent-known-set fix for PIDs
// re-parented to launchd) rather than importing them: this file is spawned
// as a raw subprocess by path (see the header above) and must keep working
// with zero build step, so it cannot depend on the TS module graph. This
// mirrors the existing precedent in this same file -- the cgroup branch
// already duplicates guardian-linux.ts's isEmpty/freeze/kill logic for the
// identical reason.

import { readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const [, , mode, boundaryArg, heartbeatFile, staleMsStr, markerFile] = process.argv;
const staleMs = Number(staleMsStr);
const cgroupPath = boundaryArg;
const rootPid = Number(boundaryArg);

// Every PID ever confirmed to descend from rootPid, for this watchdog
// process's whole lifetime. Grows across every poll iteration, never
// shrinks -- see snapshotDescendants for why forgetting a dead member is
// the bug that lets an orphaned survivor go undetected.
const known = mode === "pidtree" ? new Set([rootPid]) : undefined;

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

/**
 * Expand `knownSet` in place with every live descendant reachable, by the
 * current ppid map, from any PID already in it, then return the currently
 * alive subset. Mirrors aliveKnownDescendants in guardian-darwin.ts exactly
 * (see that file for the full rationale): walking fresh from rootPid every
 * time, instead of accumulating into a persistent set, would report "empty"
 * the instant rootPid itself died even if a live grandchild -- re-parented
 * to launchd, ppid 1 -- were still running and undetected.
 */
async function aliveKnownDescendants(knownSet) {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,stat="]);
  const byParent = new Map();
  const alive = new Set();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidStr, ppidStr, stat_] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (stat_.startsWith("Z")) continue; // zombie: already dead, cannot spawn, not signal-worthy
    alive.add(pid);
    const siblings = byParent.get(ppid) ?? [];
    siblings.push(pid);
    byParent.set(ppid, siblings);
  }
  const queue = [...knownSet].filter((pid) => alive.has(pid));
  while (queue.length > 0) {
    const pid = queue.pop();
    for (const child of byParent.get(pid) ?? []) {
      if (!knownSet.has(child)) {
        knownSet.add(child);
        queue.push(child);
      }
    }
  }
  return [...knownSet].filter((pid) => alive.has(pid));
}

function killIgnoreMissing(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone between snapshot and signal -- expected */
  }
}

async function isEmpty() {
  if (mode === "pidtree") {
    return (await aliveKnownDescendants(known)).length === 0;
  }
  try {
    const procs = await readFile(`${cgroupPath}/cgroup.procs`, "utf8");
    return procs.trim().length === 0;
  } catch {
    return true;
  }
}

async function boundaryGone() {
  if (mode === "pidtree") return isEmpty(); // no directory to outlive its last member here
  return cgroupGone();
}

async function killBoundary() {
  if (mode === "pidtree") {
    // Same bounded expand-and-kill loop as guardian-darwin.ts's
    // killPidTree(), sharing this process's long-lived `known` set: no
    // atomic "kill this whole set" primitive exists on darwin, so
    // repetition is what narrows (not closes) the fork race. Every
    // known-alive PID, root included, is killed on every pass -- an earlier
    // version held the root alive to keep the discovery window open, but
    // that only helps against an adversary that eventually stops forking;
    // against one that keeps forking for as long as its root survives, it
    // just burns the whole budget for no benefit (measured directly while
    // writing this, see docs/00-decisions.md). Killing the root immediately
    // also stops it from scheduling further children, which is exactly
    // what keeps the residual race window bounded rather than open-ended.
    const deadline = Date.now() + 3000;
    for (let i = 0; i < 40 && Date.now() < deadline; i++) {
      const pids = await aliveKnownDescendants(known);
      if (pids.length === 0) break;
      for (const pid of pids) killIgnoreMissing(pid);
      await new Promise((r) => setTimeout(r, 25));
    }
  } else {
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
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await isEmpty()) || (await boundaryGone())) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await writeFile(markerFile, String(Date.now())).catch(() => undefined);
}

async function main() {
  while (true) {
    if (await boundaryGone()) {
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
