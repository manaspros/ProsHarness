import { createHash } from "node:crypto";
import { open, mkdir, rmdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JournalEntry } from "./types.js";

/** Plain `Omit` over a union collapses to only the common fields; this distributes over each member instead. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JournalEntryInput = DistributiveOmit<JournalEntry, "seq" | "ts">;

/**
 * One serialized writer per run journal.
 *
 * Record format on disk (repeated):
 *   <8-byte big-endian length><payload bytes><8-byte big-endian checksum(payload) as first 8 bytes of sha256>
 *
 * Length-prefixing plus a trailing checksum lets a reader detect a torn tail
 * (kill -9 mid-write) unambiguously: if the declared length runs past EOF, or
 * the checksum after it does not match, the record -- and everything after it
 * -- is truncated rather than silently accepted.
 */

const LEN_BYTES = 8;
const CHECKSUM_BYTES = 8;

function checksum(payload: Buffer): Buffer {
  return createHash("sha256").update(payload).digest().subarray(0, CHECKSUM_BYTES);
}

export interface ReadResult {
  entries: JournalEntry[];
  /** True if a torn/corrupt tail was detected and truncated. */
  truncated: boolean;
  /** Byte offset of the last confirmed-good record end. */
  validByteLength: number;
}

/**
 * A run's journal can legitimately be written by more than one OS process:
 * the daemon/test harness holding the run's Barrier, and each per-attempt
 * MCP server subprocess (e.g. ask-human.ts) that also opens a Barrier onto
 * the same run directory. "One serialized writer" therefore cannot mean
 * "one process" -- it has to hold across processes. `mkdir` is atomic and
 * fails if the directory already exists, which makes it a serviceable
 * cross-process mutex with no extra dependency.
 */
async function withCrossProcessLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(runDir, ".journal.lock");
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`journal lock at ${lockPath} held too long -- possible stuck writer`);
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

export class Journal {
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Test-only fault injection: makes the next append() reject as though the
   * OS returned an IO error (ENOSPC/EIO), without needing to actually fill a
   * disk in CI. Real disk-full and real permission errors surface the same
   * way -- appendFile/sync rejecting -- this just makes the fault
   * deterministic. Never set outside tests.
   */
  private injectFailureOnce = false;

  simulateIOFailureOnce(): void {
    this.injectFailureOnce = true;
  }

  private constructor(
    private readonly filePath: string,
    private readonly dirPath: string,
  ) {}

  static async open(runDir: string): Promise<Journal> {
    await mkdir(runDir, { recursive: true });
    return new Journal(path.join(runDir, "journal.ndjson"), runDir);
  }

  /** Append one entry. Resolves only after fsync(file) and fsync(directory). */
  async append(entry: JournalEntryInput): Promise<JournalEntry> {
    const task = this.writeQueue.then(() => this.writeOne(entry));
    // Chain regardless of success so one failure doesn't wedge the serialized writer
    // for entries queued after it, but the caller of the failing append still throws.
    this.writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async writeOne(entry: JournalEntryInput): Promise<JournalEntry> {
    if (this.injectFailureOnce) {
      this.injectFailureOnce = false;
      throw Object.assign(new Error("simulated IO error (ENOSPC)"), { code: "ENOSPC" });
    }

    return withCrossProcessLock(this.dirPath, async () => {
      // The next seq number must be read fresh from disk, under the lock,
      // not cached in this instance -- another process may have appended
      // since this Journal object was constructed or last wrote.
      const existing = await Journal.readRaw(this.filePath);
      const nextSeq = existing.entries.length > 0 ? existing.entries[existing.entries.length - 1]!.seq + 1 : 0;

      const full: JournalEntry = { ...entry, seq: nextSeq, ts: new Date().toISOString() } as JournalEntry;
      const payload = Buffer.from(JSON.stringify(full), "utf8");
      const len = Buffer.alloc(LEN_BYTES);
      len.writeBigUInt64BE(BigInt(payload.length));
      const sum = checksum(payload);
      const record = Buffer.concat([len, payload, sum]);

      const handle = await open(this.filePath, "a");
      try {
        await handle.appendFile(record);
        await handle.sync(); // fsync the file
      } finally {
        await handle.close();
      }
      await Journal.fsyncDir(this.dirPath); // fsync the containing directory (rename/append durability)

      return full;
    });
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  static async fsyncDir(dirPath: string): Promise<void> {
    const dh = await open(dirPath, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  /** Replay the journal from disk. Stops at the first bad checksum/short read and reports truncation. */
  static async read(runDir: string): Promise<ReadResult> {
    return Journal.readRaw(path.join(runDir, "journal.ndjson"));
  }

  private static async readRaw(filePath: string): Promise<ReadResult> {
    let buf: Buffer;
    try {
      buf = await readFile(filePath);
    } catch (err: any) {
      if (err?.code === "ENOENT") return { entries: [], truncated: false, validByteLength: 0 };
      throw err;
    }

    const entries: JournalEntry[] = [];
    let offset = 0;
    let truncated = false;

    while (offset < buf.length) {
      if (offset + LEN_BYTES > buf.length) {
        truncated = true;
        break;
      }
      const len = Number(buf.readBigUInt64BE(offset));
      const payloadStart = offset + LEN_BYTES;
      const payloadEnd = payloadStart + len;
      const sumEnd = payloadEnd + CHECKSUM_BYTES;
      if (len < 0 || sumEnd > buf.length) {
        truncated = true;
        break;
      }
      const payload = buf.subarray(payloadStart, payloadEnd);
      const storedSum = buf.subarray(payloadEnd, sumEnd);
      const expectedSum = checksum(payload);
      if (!storedSum.equals(expectedSum)) {
        truncated = true;
        break;
      }
      let parsed: JournalEntry;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        truncated = true;
        break;
      }
      entries.push(parsed);
      offset = sumEnd;
    }

    return { entries, truncated, validByteLength: offset };
  }

  static async exists(runDir: string): Promise<boolean> {
    try {
      await stat(path.join(runDir, "journal.ndjson"));
      return true;
    } catch {
      return false;
    }
  }
}
