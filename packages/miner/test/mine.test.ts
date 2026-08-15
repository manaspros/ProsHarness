import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMining, writeMiningOutput } from "../src/mine.js";
import type { MiningOutput } from "../src/mine.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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

function fakeMiningOutput(): MiningOutput {
  return {
    generatedAt: new Date(0).toISOString(),
    corrections: [
      { sessionId: "s1", project: "/fake/proj", timestampMs: 0, quote: "please revert this", category: "revert", lineIndex: 0 },
    ],
    sessionCards: [
      {
        sessionId: "s1",
        project: "/fake/proj",
        openingPrompt: "fix the login bug",
        toolCounts: { Bash: 1 },
        bashVerbs: { git: 1 },
        subagentTypes: [],
        skillsInvoked: [],
        filesWritten: ["/fake/proj/a.ts"],
        hasPrLink: false,
        prUrls: [],
        hasPlanArtifact: false,
        turnCount: 1,
      },
    ],
    clusters: [],
    proposals: [],
  };
}

test("writeMiningOutput: writes exactly the 4 documented files + vocabulary, valid JSON, only inside outDir", async () => {
  const outDir = await makeTempDir("pros-miner-out-");
  const unrelatedHistoryRoot = await makeTempDir("pros-miner-unrelated-history-");
  try {
    await mkdir(path.join(unrelatedHistoryRoot, "projects"), { recursive: true });
    await writeFile(path.join(unrelatedHistoryRoot, "history.jsonl"), "{}\n", "utf8");
    const before = await snapshot(unrelatedHistoryRoot);

    const output = fakeMiningOutput();
    writeMiningOutput(output, outDir);

    for (const name of ["proposals.json", "session-cards.json", "history-vocabulary.json", "corrections.json", "clusters.json"]) {
      assert.ok(existsSync(path.join(outDir, name)), `expected ${name} to exist`);
      const parsed = JSON.parse(await readFile(path.join(outDir, name), "utf8"));
      assert.equal(typeof parsed.generatedAt, "string");
    }

    const proposalsJson = JSON.parse(await readFile(path.join(outDir, "proposals.json"), "utf8"));
    assert.deepEqual(Object.keys(proposalsJson).sort(), ["generatedAt", "proposals"]);

    const cardsJson = JSON.parse(await readFile(path.join(outDir, "session-cards.json"), "utf8"));
    assert.deepEqual(Object.keys(cardsJson).sort(), ["generatedAt", "sessionCards"]);

    const vocabJson = JSON.parse(await readFile(path.join(outDir, "history-vocabulary.json"), "utf8"));
    assert.deepEqual(Object.keys(vocabJson).sort(), ["bashVerbs", "fileExtensions", "generatedAt", "toolNames"]);
    assert.deepEqual(vocabJson.bashVerbs, ["git"]);
    assert.deepEqual(vocabJson.toolNames, ["Bash"]);
    assert.deepEqual(vocabJson.fileExtensions, [".ts"]);

    const correctionsJson = JSON.parse(await readFile(path.join(outDir, "corrections.json"), "utf8"));
    assert.deepEqual(Object.keys(correctionsJson).sort(), ["corrections", "generatedAt"]);

    const clustersJson = JSON.parse(await readFile(path.join(outDir, "clusters.json"), "utf8"));
    assert.deepEqual(Object.keys(clustersJson).sort(), ["clusters", "generatedAt"]);

    const after = await snapshot(unrelatedHistoryRoot);
    assert.deepEqual(after, before, "writeMiningOutput must never touch an unrelated historyRoot");
  } finally {
    await cleanup(outDir);
    await cleanup(unrelatedHistoryRoot);
  }
});

test("runMining: end-to-end over a richer synthetic fixture produces a triage cluster and >=20 corrections", async () => {
  const historyRoot = await makeTempDir("pros-miner-e2e-");
  try {
    const bucketDir = path.join(historyRoot, "projects", "-fake-projects-mothership");
    await mkdir(bucketDir, { recursive: true });

    const historyLines: string[] = [];
    const correctionPhrasesByCategory: Record<string, string[]> = {
      revert: ["please revert this change", "revert the last commit", "we need to revert", "revert it now", "can you revert"],
      "still-broken": [
        "still broken after your fix",
        "this is still not working",
        "it's still failing on ci",
        "still the same error as before",
        "still an issue after deploy",
      ],
      "no-wrong": ["no, that's wrong", "nope, not correct", "that's incorrect", "you're wrong about this", "no you misunderstood, wrong approach"],
      "i-told-you": ["i already told you this", "as i mentioned earlier", "i said this before", "i already said that", "as i said, use sonnet"],
    };

    let ts = 1700000000000;
    for (const [, phrases] of Object.entries(correctionPhrasesByCategory)) {
      for (const phrase of phrases) {
        historyLines.push(
          JSON.stringify({ display: phrase, timestamp: ts, project: "/fake/mothership", sessionId: `corr-${ts}` }),
        );
        ts += 1000;
      }
    }
    assert.ok(historyLines.length >= 20);

    // Triage cluster: 4 sessions matching "ticket/error triage", 3 gated.
    const triageSessions = [
      { id: "triage-1", prompt: "triage ticket ABC-101, please investigate", hasPrLink: true, hasPlan: false },
      { id: "triage-2", prompt: "debug ticket ABC-102 error in prod", hasPrLink: true, hasPlan: false },
      { id: "triage-3", prompt: "fix ticket ABC-103, this is broken again", hasPrLink: false, hasPlan: true },
      { id: "triage-4", prompt: "investigate incident ABC-104", hasPrLink: false, hasPlan: false },
    ];

    for (const s of triageSessions) {
      historyLines.push(JSON.stringify({ display: s.prompt, timestamp: ts, project: "/fake/mothership", sessionId: s.id }));
      ts += 1000;

      const rows: unknown[] = [
        { type: "user", message: { content: s.prompt }, sessionId: s.id, cwd: "/fake/mothership" },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] }, sessionId: s.id },
      ];
      if (s.hasPlan) {
        rows.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: {} }] }, sessionId: s.id });
      }
      if (s.hasPrLink) {
        rows.push({ type: "pr-link", sessionId: s.id, prNumber: 1, prUrl: `https://github.com/fake-org/mothership/pull/${s.id}`, prRepository: "fake-org/mothership" });
      }
      await writeFile(path.join(bucketDir, `${s.id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }

    await writeFile(path.join(historyRoot, "history.jsonl"), historyLines.join("\n") + "\n", "utf8");

    const output = runMining(historyRoot);

    assert.ok(output.corrections.length >= 20, `expected >=20 corrections, got ${output.corrections.length}`);
    assert.ok(output.clusters.length > 0, "expected at least one cluster");

    const triageCluster = output.clusters.find((c) => c.label === "ticket/error triage");
    assert.ok(triageCluster, "expected a ticket/error triage cluster");
    assert.equal(triageCluster!.sessionIds.length, 4);
    assert.equal(triageCluster!.gatedSessionIds.length, 3);

    assert.ok(output.proposals.some((p) => p.kind === "workflow"), "expected at least one workflow proposal");
    assert.ok(output.proposals.some((p) => p.kind === "preference"), "expected at least one preference proposal");
  } finally {
    await cleanup(historyRoot);
  }
});
