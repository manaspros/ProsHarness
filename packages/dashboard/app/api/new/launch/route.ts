/**
 * POST /api/new/launch
 *
 * Front door for starting a REAL plan run (Gate 1) from the dashboard.
 * Mirrors packages/cli/src/plan.ts's `runPlanCommand` -- same
 * `runPlanPipeline` call from `@pros/plan`, same `worktreesRoot`/`runsRoot`
 * defaulting convention (`PROS_WORKTREES_DIR`/`PROS_RUNS_DIR`, falling back
 * to `<HOME>/.pros/...`) as `scripts/seed-demo.ts` and the CLI use -- so a
 * run launched here shows up in the exact same place a `pros plan` CLI
 * invocation would.
 *
 * `runPlanPipeline` defaults `claudeSession`/`codexSession` to
 * `RealClaudeSession`/`RealCodexSession` itself when not given (see
 * packages/plan/src/pipeline.ts) -- exactly like the real CLI -- so this
 * spends real Claude/Codex subscription usage. That is the intended
 * behaviour, not a bug: the client is required to show a confirmation step
 * before calling this route.
 *
 * Because a real run can take tens of seconds to minutes (finding + debate
 * rounds against real `claude`/`codex` subprocesses), this route does NOT
 * await the pipeline. It generates the runId up front, fires
 * `runPlanPipeline` in the background (the Node process backing `next
 * start`/`next dev` stays alive independent of this request, so the
 * in-flight promise keeps running after the response is sent), and returns
 * `{ ok: true, runId }` immediately so the client can redirect to
 * `/runs/<runId>/plan?pending=1` right away. That Plan Review page polls
 * until the journal contains the Gate 1 plan and approval checkpoint.
 *
 * Only the "manual" trigger source actually launches a plan run here.
 * Sweep/Linear/Slack/Granola are real, wired sources (see
 * packages/triggers/src/sources/*.ts), but this route deliberately does not
 * re-derive their fetch here -- the dashboard's /new form uses the sibling
 * `/api/new/scan` route (POST { repoRoot, source }) to actually run one of
 * those sources' `fetchSignals()` for real, lets the human pick a finding
 * to pre-fill the description, and then submits *that* through this same
 * manual flow (`source: "manual"`) to actually launch. Requesting a
 * non-manual source directly against *this* route still returns an honest
 * message rather than silently no-oping, since this route was never meant
 * to be the one that runs those sources.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runPlanPipeline } from "@pros/plan";
import { Journal, loadRunState } from "@pros/barrier";
import { getRunsRoot } from "../../../../lib/config";

export type TriggerSourceId = "manual" | "sweep" | "linear" | "slack" | "granola";

const NOT_WIRED_REASONS: Record<Exclude<TriggerSourceId, "manual">, string> = {
  sweep:
    "use the \"Scan for TODOs\" action on the Sweep tab instead -- it runs the real local scan (packages/triggers/src/sources/sweep.ts) via /api/new/scan and lets you pick a finding to launch with.",
  linear:
    "use the scan action on the Linear tab instead -- it runs the real Linear MCP fetch (packages/triggers/src/sources/linear.ts) via /api/new/scan and lets you pick an issue to launch with.",
  slack:
    "use the scan action on the Slack tab instead -- it runs the real Slack MCP fetch (packages/triggers/src/sources/slack.ts) via /api/new/scan and lets you pick a message to launch with.",
  granola:
    "use the scan action on the Granola tab instead -- it runs the real Granola MCP fetch (packages/triggers/src/sources/granola.ts) via /api/new/scan and lets you pick a note to launch with.",
};

function getWorktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  // Same convention as packages/cli/src/plan.ts / scripts/seed-demo.ts:
  // PROS_WORKTREES_DIR, falling back to <HOME>/.pros/worktrees.
  return env.PROS_WORKTREES_DIR ?? path.join(env.HOME ?? "/root", ".pros", "worktrees");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { repoRoot?: string; description?: string; source?: string };
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `could not parse request body as JSON: ${err?.message ?? err}` }, { status: 400 });
  }

  const source = (body.source ?? "manual") as TriggerSourceId;
  const description = body.description?.trim() ?? "";
  const repoRoot = body.repoRoot?.trim() ?? "";
  // The dashboard's session workflow always runs Claude Code with the
  // permission bypass enabled. Keep this server-side so callers cannot
  // accidentally reintroduce a UI toggle or forget the flag.
  const dangerouslySkipPermissions = true;

  if (source !== "manual") {
    const reason = NOT_WIRED_REASONS[source as Exclude<TriggerSourceId, "manual">];
    if (!reason) {
      return NextResponse.json({ error: `unknown trigger source: ${source}` }, { status: 400 });
    }
    return NextResponse.json({ ok: false, message: reason }, { status: 200 });
  }

  if (!repoRoot) {
    return NextResponse.json({ error: "repoRoot is required" }, { status: 400 });
  }
  if (!description) {
    return NextResponse.json({ error: "description is required (describe a finding or paste one)" }, { status: 400 });
  }

  const runsRoot = getRunsRoot();
  const worktreesRoot = getWorktreesRoot();
  const runId = randomUUID();
  await recordOperation(runsRoot, runId, "plan_pipeline", "started", undefined, "human", dangerouslySkipPermissions);

  // Fire-and-forget: do not await. Errors are logged server-side rather than
  // surfaced to this response, which has already promised a runId -- the
  // run's own journal/page is the source of truth for what actually
  // happened, matching how a `pros plan` CLI failure would only ever show
  // up as "no plan.md / no parked checkpoint" for that runId, not as an
  // HTTP error here.
  runPlanPipeline({
    repoRoot: path.resolve(repoRoot),
    worktreesRoot,
    runsRoot,
    description,
    runId,
    dangerouslySkipPermissions,
  }).then(() => recordOperation(runsRoot, runId, "plan_pipeline", "success")).catch((err) => {
    console.error(`[api/new/launch] runPlanPipeline failed for runId=${runId}:`, err);
    return recordOperation(runsRoot, runId, "plan_pipeline", "failed", err instanceof Error ? err.message : String(err));
  }).catch((err) => {
    console.error(`[api/new/launch] could not record plan operation for runId=${runId}:`, err);
  });

  return NextResponse.json({ ok: true, runId });
}

async function recordOperation(
  runsRoot: string,
  runId: string,
  operation: "plan_pipeline",
  outcome: "started" | "success" | "failed",
  error?: string,
  requestedBy?: string,
  dangerouslySkipPermissions?: boolean,
): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  const journal = await Journal.open(runDir);
  try {
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;
    await journal.append(
      outcome === "started"
        ? { runId, fenceEpoch, kind: "plan_operation_started", operation, requestedBy, dangerouslySkipPermissions }
        : { runId, fenceEpoch, kind: "plan_operation_completed", operation, outcome, error },
    );
  } finally {
    await journal.close();
  }
}
