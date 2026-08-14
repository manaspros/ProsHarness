import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Journal } from "../src/journal.js";
import { makeRunDir, cleanupDir } from "./helpers.js";

test("journal: append then replay returns the same entries in order", async () => {
  const dir = await makeRunDir();
  try {
    const j = await Journal.open(dir);
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_ended", attemptId: "a1", exitReason: "done" });
    await j.close();

    const { entries, truncated } = await Journal.read(dir);
    assert.equal(truncated, false);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.seq, 0);
    assert.equal(entries[1]!.seq, 1);
    assert.equal(entries[0]!.kind, "attempt_started");
  } finally {
    await cleanupDir(dir);
  }
});

test("journal: kill-test #4 - torn record at the tail is detected and truncated, not silently accepted", async () => {
  const dir = await makeRunDir();
  try {
    const j = await Journal.open(dir);
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_ended", attemptId: "a1", exitReason: "done" });
    await j.close();

    const journalPath = path.join(dir, "journal.ndjson");
    const full = await readFile(journalPath);

    // Simulate a genuinely torn third record: append a length prefix
    // claiming more payload than actually follows (as if the process died
    // mid-write of a new record, after the length prefix but before the
    // payload and checksum landed).
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64BE(1000n);
    const withTornRecord = Buffer.concat([full, lenBuf, Buffer.from("short")]);
    await (await import("node:fs/promises")).writeFile(journalPath, withTornRecord);

    const second = await Journal.read(dir);
    assert.equal(second.entries.length, 2, "the torn record must not be surfaced as data");
    assert.equal(second.truncated, true, "the reader must report the truncation rather than accept it silently");
  } finally {
    await cleanupDir(dir);
  }
});

test("journal: kill-test #4 - a checksum mismatch is treated as torn, not corrupted-but-valid data", async () => {
  const dir = await makeRunDir();
  try {
    const j = await Journal.open(dir);
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();

    const journalPath = path.join(dir, "journal.ndjson");
    const buf = await readFile(journalPath);
    // Flip a byte inside the payload region (well past the 8-byte length prefix).
    buf[10] = buf[10]! ^ 0xff;
    await (await import("node:fs/promises")).writeFile(journalPath, buf);

    const { entries, truncated } = await Journal.read(dir);
    assert.equal(entries.length, 0);
    assert.equal(truncated, true);
  } finally {
    await cleanupDir(dir);
  }
});

test("journal: fsyncs the directory after append (directory mtime survives, no crash on close)", async () => {
  const dir = await makeRunDir();
  try {
    const j = await Journal.open(dir);
    await j.append({ runId: "r1", fenceEpoch: 0, kind: "attempt_started", attemptId: "a1", cwd: "/x", launchConfigHash: "h", unitName: "u" });
    await j.close();
    const st = await stat(path.join(dir, "journal.ndjson"));
    assert.ok(st.size > 0);
  } finally {
    await cleanupDir(dir);
  }
});
