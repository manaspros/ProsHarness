import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mineCorrections } from "../src/corrections.js";
import { buildSessionCards } from "../src/session-cards.js";
import { readHistoryLines, listSessionTranscriptFiles, readSessionTranscript } from "../src/history-source.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function buildFixtureHistoryRoot(): Promise<string> {
  const historyRoot = await makeTempDir("pros-miner-readonly-");
  const bucketDir = path.join(historyRoot, "projects", "-fake-projects-widget");
  await mkdir(bucketDir, { recursive: true });

  await writeFile(
    path.join(historyRoot, "history.jsonl"),
    [
      JSON.stringify({ display: "fix the login bug, still broken", timestamp: 1, project: "/fake/widget", sessionId: "s1" }),
      JSON.stringify({ display: "please revert this", timestamp: 2, project: "/fake/widget", sessionId: "s1" }),
    ].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    path.join(bucketDir, "s1.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "fix the login bug" }, sessionId: "s1", cwd: "/fake/widget" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] }, sessionId: "s1" }),
    ].join("\n") + "\n",
    "utf8",
  );

  return historyRoot;
}

interface Snapshot {
  [relPath: string]: { size: number; mtimeMs: number };
}

async function snapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = {};
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const st = await stat(full);
        result[path.relative(root, full)] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  }
  await walk(root);
  return result;
}

test("read-only: source files never reference write-ish fs APIs (static grep)", async () => {
  const filesToCheck = ["history-source.ts", "corrections.ts", "session-cards.ts"];
  const bannedIdentifiers = [
    "writeFileSync",
    "appendFileSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "promises.writeFile",
    "promises.rm",
    "promises.unlink",
  ];
  for (const file of filesToCheck) {
    const contents = await readFile(path.join(__dirname, "../src", file), "utf8");
    for (const banned of bannedIdentifiers) {
      assert.equal(contents.includes(banned), false, `${file} must not reference ${banned}`);
    }
  }
});

test("read-only: reading functions never mutate the history root (behavioral snapshot)", async () => {
  const historyRoot = await buildFixtureHistoryRoot();
  try {
    const before = await snapshot(historyRoot);

    readHistoryLines(historyRoot);
    listSessionTranscriptFiles(historyRoot);
    for (const file of listSessionTranscriptFiles(historyRoot)) {
      readSessionTranscript(file);
    }
    mineCorrections(historyRoot);
    buildSessionCards(historyRoot);

    const after = await snapshot(historyRoot);
    assert.deepEqual(after, before, "historyRoot must be byte-for-byte / mtime-for-mtime unchanged after read operations");
  } finally {
    await cleanup(historyRoot);
  }
});
