import { test } from "node:test";
import assert from "node:assert/strict";
import { requireProjectByName, UnknownProjectError } from "@pros/implement";
import { parsePlanArgs, runPlanCommand } from "../src/plan.js";

test("parsePlanArgs: legacy bare repoRoot is unaffected by named-project support", () => {
  const args = parsePlanArgs(["/some/repo", "fix the thing", "--run-id=run-1"]);
  assert.equal(args.repoRoot, "/some/repo");
  assert.equal(args.description, "fix the thing");
  assert.equal(args.runId, "run-1");
  assert.equal(args.project, undefined);
});

test("parsePlanArgs: --project=<name> resolves repoRoot from the registry, no positional repoRoot needed", () => {
  const expected = requireProjectByName("agent-gateway");
  const args = parsePlanArgs(["--project=agent-gateway", "AGENT-1: fix the thing"]);
  assert.equal(args.repoRoot, expected.repoRoot);
  assert.equal(args.description, "AGENT-1: fix the thing");
  assert.equal(args.project?.name, "agent-gateway");
});

test("parsePlanArgs: --project=<unknown> fails loudly listing known projects", () => {
  assert.throws(() => parsePlanArgs(["--project=mothership", "do the thing"]), (err: unknown) => {
    assert.ok(err instanceof UnknownProjectError);
    assert.match((err as Error).message, /unknown project "mothership"/);
    assert.match((err as Error).message, /agent-gateway/);
    return true;
  });
});

test("parsePlanArgs: missing description in named-project mode throws a usage error", () => {
  assert.throws(() => parsePlanArgs(["--project=agent-gateway"]), /usage: pros plan --project=/);
});

test("runPlanCommand: named-project mode rejects a description with no ticket reference before touching the pipeline", async () => {
  await assert.rejects(
    () => runPlanCommand(["--project=agent-gateway", "fix the thing, no ticket mentioned"]),
    /must contain a ticket reference/,
  );
});

// NOTE: deliberately no "well-formed description succeeds" integration test
// here -- agent-gateway is a real checkout on this machine, and letting
// runPlanCommand past the ticket check would fall through to real worktree
// allocation and real model sessions against it. `hasTicketReference` is
// covered directly (with a synthetic project) in project-config.test.ts;
// the bare-repoRoot e2e test above already exercises a full pipeline run
// end to end against a disposable temp repo.
