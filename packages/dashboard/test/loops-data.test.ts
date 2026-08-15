import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { getMinerOutDir, loadProposals, groupProposalsByKind, type LoopProposal } from "../lib/loops-data.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("getMinerOutDir: respects PROS_MINER_OUT when set", () => {
  const saved = process.env.PROS_MINER_OUT;
  try {
    process.env.PROS_MINER_OUT = "/tmp/some-custom-miner-out";
    assert.equal(getMinerOutDir(), "/tmp/some-custom-miner-out");
  } finally {
    if (saved === undefined) delete process.env.PROS_MINER_OUT;
    else process.env.PROS_MINER_OUT = saved;
  }
});

test("getMinerOutDir: falls back to <HOME>/.pros/miner when unset", () => {
  const saved = process.env.PROS_MINER_OUT;
  try {
    delete process.env.PROS_MINER_OUT;
    assert.equal(getMinerOutDir(), path.join(homedir(), ".pros", "miner"));
  } finally {
    if (saved === undefined) delete process.env.PROS_MINER_OUT;
    else process.env.PROS_MINER_OUT = saved;
  }
});

test("loadProposals: missing file -> unavailable, empty proposals", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    const result = loadProposals(dir);
    assert.deepEqual(result, { available: false, proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadProposals: valid file with a workflow and a preference proposal parses correctly", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    const file = {
      generatedAt: "2026-08-15T00:00:00.000Z",
      proposals: [
        {
          id: "workflow-ticket-error-triage",
          kind: "workflow",
          name: "Recurring workflow: ticket/error triage",
          evidenceSummary: "14 sessions matched this pattern, 6 with a linked PR or plan artifact.",
          sessionCount: 14,
          gatedSessionCount: 6,
          exampleQuotes: ["investigate ticket ABC-123, mothership is throwing 500s again"],
          status: "proposed",
        },
        {
          id: "preference-still-broken",
          kind: "preference",
          name: 'Preference: reduce "still-broken" corrections',
          evidenceSummary: "12 corrections of this kind across 9 sessions.",
          sessionCount: 9,
          gatedSessionCount: 0,
          exampleQuotes: ["still broken, the same 500 as before"],
          status: "proposed",
        },
      ],
    };
    await writeFile(path.join(dir, "proposals.json"), JSON.stringify(file));

    const result = loadProposals(dir);
    assert.equal(result.available, true);
    assert.equal(result.generatedAt, "2026-08-15T00:00:00.000Z");
    assert.equal(result.proposals.length, 2);
    assert.equal(result.proposals[0]!.kind, "workflow");
    assert.equal(result.proposals[1]!.kind, "preference");
  } finally {
    await cleanup(dir);
  }
});

test("loadProposals: malformed JSON -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    await writeFile(path.join(dir, "proposals.json"), "{ this is not valid json ][");
    const result = loadProposals(dir);
    assert.deepEqual(result, { available: false, proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadProposals: valid JSON but wrong shape (proposals not an array) -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    await writeFile(path.join(dir, "proposals.json"), JSON.stringify({ generatedAt: "x", proposals: "not-an-array" }));
    const result = loadProposals(dir);
    assert.deepEqual(result, { available: false, proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadProposals: valid JSON missing the proposals key entirely -> unavailable, no throw", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    await writeFile(path.join(dir, "proposals.json"), JSON.stringify({ generatedAt: "x" }));
    const result = loadProposals(dir);
    assert.deepEqual(result, { available: false, proposals: [] });
  } finally {
    await cleanup(dir);
  }
});

test("loadProposals: one malformed proposal entry is dropped, valid ones survive", async () => {
  const dir = await makeTempDir("pros-dash-loops-");
  try {
    const file = {
      generatedAt: "2026-08-15T00:00:00.000Z",
      proposals: [
        {
          id: "workflow-good",
          kind: "workflow",
          name: "Good workflow",
          evidenceSummary: "summary",
          sessionCount: 3,
          gatedSessionCount: 1,
          exampleQuotes: ["quote"],
          status: "proposed",
        },
        {
          id: "preference-missing-fields",
          kind: "preference",
          // missing name, evidenceSummary, etc.
          sessionCount: 2,
        },
      ],
    };
    await writeFile(path.join(dir, "proposals.json"), JSON.stringify(file));

    const result = loadProposals(dir);
    assert.equal(result.available, true);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0]!.id, "workflow-good");
  } finally {
    await cleanup(dir);
  }
});

test("groupProposalsByKind: splits mixed array, preserves order within each group", () => {
  const proposals: LoopProposal[] = [
    {
      id: "w1",
      kind: "workflow",
      name: "w1",
      evidenceSummary: "",
      sessionCount: 1,
      gatedSessionCount: 0,
      exampleQuotes: [],
      status: "proposed",
    },
    {
      id: "p1",
      kind: "preference",
      name: "p1",
      evidenceSummary: "",
      sessionCount: 1,
      gatedSessionCount: 0,
      exampleQuotes: [],
      status: "proposed",
    },
    {
      id: "w2",
      kind: "workflow",
      name: "w2",
      evidenceSummary: "",
      sessionCount: 1,
      gatedSessionCount: 0,
      exampleQuotes: [],
      status: "proposed",
    },
    {
      id: "p2",
      kind: "preference",
      name: "p2",
      evidenceSummary: "",
      sessionCount: 1,
      gatedSessionCount: 0,
      exampleQuotes: [],
      status: "proposed",
    },
  ];

  const { workflows, preferences } = groupProposalsByKind(proposals);
  assert.deepEqual(
    workflows.map((p) => p.id),
    ["w1", "w2"],
  );
  assert.deepEqual(
    preferences.map((p) => p.id),
    ["p1", "p2"],
  );
});

test("groupProposalsByKind: empty input -> both groups empty", () => {
  const { workflows, preferences } = groupProposalsByKind([]);
  assert.deepEqual(workflows, []);
  assert.deepEqual(preferences, []);
});

test("loops page: keeps proposal rendering server-side and exposes only the dedicated regeneration action", async () => {
  const pagePath = path.join(import.meta.dirname, "..", "app", "loops", "page.tsx");
  const source = await readFile(pagePath, "utf8");

  const forbidden = ['"use client"', "<form", "onClick", "onSubmit", "fetch(", 'method: "POST"'];
  for (const needle of forbidden) {
    assert.ok(!source.includes(needle), `page.tsx must not contain ${JSON.stringify(needle)}`);
  }
  assert.match(source, /RegenerateAction/);
  assert.match(source, /PROS_MINER_OUT/);

  const actionSource = await readFile(path.join(import.meta.dirname, "..", "components", "RegenerateAction.tsx"), "utf8");
  assert.match(actionSource, /\/api\/loops\/regenerate/);
  assert.match(actionSource, /router\.refresh\(\)/);
  assert.match(actionSource, /local Claude Code history/);
});
