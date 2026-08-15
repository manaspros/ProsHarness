import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Journal } from "@pros/barrier";
import { WorktreeAllocator, AllocationCrashInjected } from "../src/allocator.js";
import { makeSandbox, cleanupSandbox, pathExists, git, mkdir, writeFile, type Sandbox } from "./helpers.js";

function sortedReport(report: { finished: string[]; rolledBack: string[]; alreadyOk: string[] }) {
  return {
    finished: [...report.finished].sort(),
    rolledBack: [...report.rolledBack].sort(),
    alreadyOk: [...report.alreadyOk].sort(),
  };
}

test("happy path: allocate() produces a real worktree + branch; worktree_confirmed is the last entry; reconcile is a no-op", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const runId = "run-happy";
    const result = await allocator.allocate(runId);

    assert.equal(await pathExists(result.path), true, "worktree directory should exist");
    const branchList = await git(sb.repoRoot, ["branch", "--list", result.branch]);
    assert.ok(branchList.includes(result.branch), "branch should exist in repoRoot");
    assert.match(result.baseSha, /^[0-9a-f]{40}$/);

    const { entries } = await Journal.read(path.join(sb.runsRoot, runId));
    const relevant = entries.filter((e) => "allocationId" in e && (e as any).allocationId === result.allocationId);
    assert.equal(relevant.length, 3, "intent, allocated, confirmed");
    assert.equal(relevant[relevant.length - 1]!.kind, "worktree_confirmed");

    const report = await allocator.reconcile();
    assert.deepEqual(sortedReport(report), { finished: [], rolledBack: [], alreadyOk: [result.allocationId] });

    // Second reconcile is still a no-op.
    const report2 = await allocator.reconcile();
    assert.deepEqual(sortedReport(report2), { finished: [], rolledBack: [], alreadyOk: [result.allocationId] });
  } finally {
    await cleanupSandbox(sb);
  }
});

test("crash after intent, before act: no worktree on disk; reconcile rolls back the bare intent; idempotent", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const runId = "run-crash-intent";

    await assert.rejects(() => allocator.allocate(runId, { crashAfter: "intent" }), AllocationCrashInjected);

    const { entries } = await Journal.read(path.join(sb.runsRoot, runId));
    const intent = entries.find((e) => e.kind === "worktree_intent");
    assert.ok(intent, "intent must have been durably appended before the crash");
    assert.equal(await pathExists((intent as any).worktreePath), false, "act never ran -- nothing on disk");

    const report = await allocator.reconcile();
    assert.deepEqual(sortedReport(report), {
      finished: [],
      rolledBack: [(intent as any).allocationId],
      alreadyOk: [],
    });

    const { entries: entries2 } = await Journal.read(path.join(sb.runsRoot, runId));
    const rollback = entries2.find((e) => e.kind === "worktree_rollback");
    assert.ok(rollback);
    assert.equal((rollback as any).reason, "intent-only, no artifact");

    const report2 = await allocator.reconcile();
    assert.deepEqual(sortedReport(report2), {
      finished: [],
      rolledBack: [],
      alreadyOk: [(intent as any).allocationId],
    });
  } finally {
    await cleanupSandbox(sb);
  }
});

test("crash after act (git worktree add succeeded), before worktree_allocated: reconcile finishes it (adopts real work)", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const runId = "run-crash-act";

    await assert.rejects(() => allocator.allocate(runId, { crashAfter: "act" }), AllocationCrashInjected);

    const { entries } = await Journal.read(path.join(sb.runsRoot, runId));
    const intent = entries.find((e) => e.kind === "worktree_intent") as any;
    assert.ok(intent);
    assert.ok(!entries.some((e) => e.kind === "worktree_allocated"), "act crash happens before this entry lands");
    assert.equal(await pathExists(intent.worktreePath), true, "git worktree add itself succeeded");

    const report = await allocator.reconcile();
    // DESIGN CHOICE (documented in allocator.ts reconcile()): a real, valid
    // git worktree on disk is real work -- adopt it (finish/confirm) rather
    // than destroy it, even though worktree_allocated never landed.
    assert.deepEqual(sortedReport(report), { finished: [intent.allocationId], rolledBack: [], alreadyOk: [] });

    const { entries: entries2 } = await Journal.read(path.join(sb.runsRoot, runId));
    assert.ok(entries2.some((e) => e.kind === "worktree_allocated" && (e as any).allocationId === intent.allocationId));
    assert.ok(entries2.some((e) => e.kind === "worktree_confirmed" && (e as any).allocationId === intent.allocationId));
    assert.equal(await pathExists(intent.worktreePath), true, "worktree must survive -- it was adopted, not removed");

    const report2 = await allocator.reconcile();
    assert.deepEqual(sortedReport(report2), { finished: [], rolledBack: [], alreadyOk: [intent.allocationId] });
  } finally {
    await cleanupSandbox(sb);
  }
});

test("crash after worktree_allocated, before worktree_confirmed: reconcile finishes it rather than destroying a valid worktree", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const runId = "run-crash-allocated";

    await assert.rejects(() => allocator.allocate(runId, { crashAfter: "allocated" }), AllocationCrashInjected);

    const { entries } = await Journal.read(path.join(sb.runsRoot, runId));
    const intent = entries.find((e) => e.kind === "worktree_intent") as any;
    const allocated = entries.find((e) => e.kind === "worktree_allocated") as any;
    assert.ok(intent);
    assert.ok(allocated, "worktree_allocated must have landed before this crash point");
    assert.ok(!entries.some((e) => e.kind === "worktree_confirmed"));

    const report = await allocator.reconcile();
    assert.deepEqual(sortedReport(report), { finished: [intent.allocationId], rolledBack: [], alreadyOk: [] });

    const { entries: entries2 } = await Journal.read(path.join(sb.runsRoot, runId));
    assert.ok(entries2.some((e) => e.kind === "worktree_confirmed" && (e as any).allocationId === intent.allocationId));
    assert.equal(await pathExists(intent.worktreePath), true);

    const report2 = await allocator.reconcile();
    assert.deepEqual(sortedReport(report2), { finished: [], rolledBack: [], alreadyOk: [intent.allocationId] });
  } finally {
    await cleanupSandbox(sb);
  }
});

test("crash mid `git worktree add` (garbage directory, no git registration, no branch): reconcile rolls back and leaves no trace", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const runId = "run-garbage";
    const allocationId = randomUUID();
    const worktreePath = path.join(sb.worktreesRoot, `${runId}-${allocationId}`);
    const branch = `pros/${runId}/${allocationId}`;
    const runDir = path.join(sb.runsRoot, runId);

    const journal = await Journal.open(runDir);
    await journal.append({
      runId,
      fenceEpoch: 0,
      kind: "worktree_intent",
      allocationId,
      repoRoot: sb.repoRoot,
      worktreePath,
      branch,
    });

    // Simulate a crash partway through `git worktree add`: something sits at
    // the target path, but git never registered it and no branch exists.
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, "garbage.txt"), "not a real worktree\n");

    const report = await allocator.reconcile();
    assert.deepEqual(sortedReport(report), { finished: [], rolledBack: [allocationId], alreadyOk: [] });
    assert.equal(await pathExists(worktreePath), false, "garbage directory must be removed");

    const wtList = await git(sb.repoRoot, ["worktree", "list", "--porcelain"]);
    assert.ok(!wtList.includes(worktreePath), "no dangling worktree entry");
    const branchList = await git(sb.repoRoot, ["branch", "--list", branch]);
    assert.equal(branchList.trim(), "", "no dangling branch");

    const report2 = await allocator.reconcile();
    assert.deepEqual(sortedReport(report2), { finished: [], rolledBack: [], alreadyOk: [allocationId] });
  } finally {
    await cleanupSandbox(sb);
  }
});

test("two allocate() calls for different runIds never collide: distinct paths/branches, independently writable", async () => {
  const sb = await makeSandbox();
  try {
    const allocator = new WorktreeAllocator(sb);
    const a = await allocator.allocate("run-a");
    const b = await allocator.allocate("run-b");

    assert.notEqual(a.path, b.path);
    assert.notEqual(a.branch, b.branch);

    await writeFile(path.join(a.path, "a-only.txt"), "a\n");
    await writeFile(path.join(b.path, "b-only.txt"), "b\n");
    assert.equal(await pathExists(path.join(a.path, "b-only.txt")), false);
    assert.equal(await pathExists(path.join(b.path, "a-only.txt")), false);

    const report = await allocator.reconcile();
    assert.deepEqual(sortedReport(report), {
      finished: [],
      rolledBack: [],
      alreadyOk: [a.allocationId, b.allocationId].sort(),
    });
  } finally {
    await cleanupSandbox(sb);
  }
});
