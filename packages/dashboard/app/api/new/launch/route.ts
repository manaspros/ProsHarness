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
 * `/runs/<runId>` right away and let that page's own polling reflect
 * progress as journal entries land.
 *
 * Only the "manual" trigger source is wired here. Sweep/Linear/Slack/
 * Granola sources (packages/triggers/src/sources/*.ts) are read-only
 * fixture/MCP-driven adapters meant for the ambient trigger daemon, not
 * something this route re-derives credentials/MCP wiring for -- see each
 * source file's own header. Requesting one of those returns an honest
 * "not wired yet" response instead of silently no-oping as if it launched.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runPlanPipeline } from "@pros/plan";
import { getRunsRoot } from "../../../../lib/config";

export type TriggerSourceId = "manual" | "sweep" | "linear" | "slack" | "granola";

const NOT_WIRED_REASONS: Record<Exclude<TriggerSourceId, "manual">, string> = {
  sweep:
    "not wired yet -- sweep requires running the trigger daemon against a real repo tree (packages/triggers/src/sources/sweep.ts) to produce a Signal; this UI does not run that scan for you yet.",
  linear:
    "not wired yet -- Linear requires either a Linear MCP server already connected in this environment or a PROS_LINEAR_API_KEY + apiUrl fallback (packages/triggers/src/sources/linear.ts); this UI doesn't set that up.",
  slack:
    "not wired yet -- Slack requires either a Slack MCP server already connected in this environment or an API-key fallback (packages/triggers/src/sources/slack.ts); this UI doesn't set that up.",
  granola:
    "not wired yet -- Granola requires an MCP server already connected in this environment (packages/triggers/src/sources/granola.ts); this UI doesn't set that up.",
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
  }).catch((err) => {
    console.error(`[api/new/launch] runPlanPipeline failed for runId=${runId}:`, err);
  });

  return NextResponse.json({ ok: true, runId });
}
