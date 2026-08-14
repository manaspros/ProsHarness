import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "./types.js";
import type { Barrier } from "./barrier.js";

/**
 * `--resume` restores the conversation, not the process's working directory
 * (measured -- docs/03-architecture.md). Every resume must launch from the
 * manifest's recorded cwd and reconcile against disk first: disk is the
 * authority, the agent's own recollection is not.
 */
export class CwdReconcileError extends Error {
  constructor(
    public readonly reason: "missing" | "not_a_directory" | "identity_mismatch",
    public readonly cwd: string,
  ) {
    super(`resume cwd reconciliation failed (${reason}): ${cwd}`);
    this.name = "CwdReconcileError";
  }
}

/**
 * kill-test #8: the recorded cwd may have been moved, symlinked, replaced,
 * or deleted since the manifest was written. Detect every case rather than
 * blindly launching a resumed session into whatever now sits at that path.
 */
export async function reconcileCwd(manifest: Manifest): Promise<void> {
  let st;
  try {
    st = await stat(manifest.cwd);
  } catch {
    throw new CwdReconcileError("missing", manifest.cwd);
  }
  if (!st.isDirectory()) {
    throw new CwdReconcileError("not_a_directory", manifest.cwd);
  }
  const currentReal = await realpath(manifest.cwd);
  if (currentReal !== manifest.cwdRealPath) {
    // The path exists and is a directory, but a symlink swap or a
    // replace-with-a-new-directory-of-the-same-name means it is not the
    // same real directory the manifest was snapshotted against.
    throw new CwdReconcileError("identity_mismatch", manifest.cwd);
  }
}

/**
 * Atomic, exclusive recovery lease: `open(path, "wx")` fails if the file
 * already exists, so of two racing recovery/lease-takeover attempts, exactly
 * one observes success (kill-test #11). The loser must never proceed as if
 * it also owns recovery.
 */
export async function acquireRecoveryLease(runDir: string, holderId: string): Promise<boolean> {
  const leasePath = path.join(runDir, "recovery.lease");
  try {
    const fh = await open(leasePath, "wx");
    try {
      await fh.writeFile(holderId);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

export async function releaseRecoveryLease(runDir: string, holderId: string): Promise<void> {
  const leasePath = path.join(runDir, "recovery.lease");
  let contents: string;
  try {
    contents = await (await import("node:fs/promises")).readFile(leasePath, "utf8");
  } catch {
    return; // already gone
  }
  if (contents !== holderId) {
    // Not our lease to release -- releasing it would let a second holder in.
    return;
  }
  await (await import("node:fs/promises")).unlink(leasePath).catch(() => undefined);
}

export interface RelaunchFn {
  (args: { cwd: string; manifest: Manifest }): Promise<{ attemptId: string }>;
}

/**
 * Ties the barrier's checkpoint state machine to an actual relaunch:
 * claim -> reconcile cwd against disk -> barrier.resume (records intent,
 * returns the manifest cwd) -> caller-provided relaunch -> consume.
 *
 * The manifest, not the caller's cwd, is what decides where the relaunch runs.
 */
export async function performResume(
  barrier: Barrier,
  checkpointId: string,
  manifest: Manifest,
  relaunch: RelaunchFn,
): Promise<{ attemptId: string; cwd: string }> {
  await barrier.claim(checkpointId);
  await reconcileCwd(manifest);
  const { attemptId, cwd } = await barrier.resume(checkpointId);
  const launched = await relaunch({ cwd, manifest });
  await barrier.consume(checkpointId, launched.attemptId);
  return { attemptId: launched.attemptId, cwd };
}
