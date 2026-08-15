import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/** Raised when another dashboard or scheduler process owns the operation lock. */
export class OutputLockConflict extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`a ${path.basename(lockPath)} run is already in progress`);
    this.name = "OutputLockConflict";
    this.lockPath = lockPath;
  }
}

export function getOutputLockPath(outDir: string, operation: string): string {
  return path.join(outDir, `.dashboard-${operation}.lock`);
}

/**
 * Runs one local computation while holding an atomic lock below its output
 * directory. mkdir is the ownership boundary: only the process that creates
 * the lock directory is allowed to remove it in the finally block.
 */
export async function withOutputLock<T>(opts: {
  outDir: string;
  operation: string;
  run: () => T | Promise<T>;
}): Promise<T> {
  await mkdir(opts.outDir, { recursive: true });
  const lockPath = getOutputLockPath(opts.outDir, opts.operation);

  try {
    await mkdir(lockPath);
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      throw new OutputLockConflict(lockPath);
    }
    throw error;
  }

  try {
    return await opts.run();
  } finally {
    // force:true also makes cleanup idempotent if an operator removed a stale
    // lock while the computation was still unwinding.
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
