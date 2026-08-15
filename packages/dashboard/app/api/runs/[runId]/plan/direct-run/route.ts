/**
 * Apply a user's instruction to the current plan in the same Claude session.
 * The request returns after durable operation-start is recorded; the model
 * call runs in the persistent dashboard process and the plan page polls the
 * operation journal until the new plan version is indexed.
 */
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { RealClaudeSession, refinePlanWithInstruction } from "@pros/plan";
import { getRunsRoot } from "../../../../../../lib/config";
import { loadPlanRunContext, persistPlanVersion } from "../../../../../../lib/plan-session";
import { recordPlanOperation } from "../../../../../../lib/plan-operations";
import { withOutputLock, OutputLockConflict } from "../../../../../../lib/output-lock";

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await req.json();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(json ?? {})) out[key] = String(value);
    return out;
  }
  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) out[key] = String(value);
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const { runId } = await ctx.params;
  const runsRoot = getRunsRoot();
  let body: Record<string, string>;
  try {
    body = await parseBody(req);
  } catch (err: any) {
    return respondError(req, undefined, 400, `could not parse request body: ${err?.message ?? err}`);
  }

  const redirectTo = body.redirectTo;
  const instruction = body.instruction?.trim();
  const requestedBy = body.requestedBy?.trim() || "human";
  if (!instruction) return respondError(req, redirectTo, 400, "instruction text is required");

  let context;
  try {
    context = await loadPlanRunContext(runsRoot, runId);
  } catch (err: any) {
    return respondError(req, redirectTo, 400, `could not load plan context: ${err?.message ?? String(err)}`);
  }

  try {
    await recordPlanOperation({ runId, operation: "claude_refinement", transition: "started", requestedBy });
  } catch (err: any) {
    return respondError(req, redirectTo, 500, `could not start refinement: ${err?.message ?? String(err)}`);
  }

  void withOutputLock({
    outDir: context.runDir,
    operation: "plan-operation",
    run: async () => {
      try {
        const attemptId = `${runId}-refine-${Date.now()}`;
        const revised = await refinePlanWithInstruction(new RealClaudeSession(), {
          cwd: context.worktreePath,
          finding: context.finding,
          previous: context.currentPlan,
          instruction,
          resumeSessionId: context.claudeSessionId,
          dangerouslySkipPermissions: context.dangerouslySkipPermissions,
          rawLogPath: path.join(context.runDir, "attempts", attemptId, "raw.log"),
          attemptId,
        });
        await persistPlanVersion({
          runId,
          context,
          plan: revised,
          round: 0,
          attemptId,
        });
        await recordPlanOperation({ runId, operation: "claude_refinement", transition: "success" });
      } catch (err) {
        await recordPlanOperation({
          runId,
          operation: "claude_refinement",
          transition: "failed",
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
      }
    },
  }).catch(async (err) => {
    const message = err instanceof OutputLockConflict ? "another plan operation is already running" : err instanceof Error ? err.message : String(err);
    await recordPlanOperation({ runId, operation: "claude_refinement", transition: "failed", error: message }).catch(() => undefined);
  });

  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("notice", "Claude is refining this plan in the same planning session.");
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ ok: true, started: true });
}

function respondError(req: NextRequest, redirectTo: string | undefined, status: number, message: string): NextResponse {
  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ error: message }, { status });
}
