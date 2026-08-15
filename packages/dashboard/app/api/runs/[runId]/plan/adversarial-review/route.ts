/** Run Codex's independent challenge, then resume Claude to update plan.md. */
import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { RealClaudeSession, RealCodexSession, runManualAdversarialReview } from "@pros/plan";
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

  let context;
  try {
    context = await loadPlanRunContext(runsRoot, runId);
  } catch (err: any) {
    return respondError(req, redirectTo, 400, `could not load plan context: ${err?.message ?? String(err)}`);
  }

  try {
    await recordPlanOperation({ runId, operation: "codex_review", transition: "started", requestedBy: "human" });
  } catch (err: any) {
    return respondError(req, redirectTo, 500, `could not start adversarial review: ${err?.message ?? String(err)}`);
  }

  void withOutputLock({
    outDir: context.runDir,
    operation: "plan-operation",
    run: async () => {
      try {
        const result = await runManualAdversarialReview({
          claudeSession: new RealClaudeSession(),
          codexSession: new RealCodexSession(),
          cwd: context.worktreePath,
          finding: context.finding,
          currentPlan: context.currentPlan,
          resumeSessionId: context.claudeSessionId,
          dangerouslySkipPermissions: context.dangerouslySkipPermissions,
          rawLogPathForAttempt: (attemptId) => path.join(context.runDir, "attempts", attemptId, "raw.log"),
          attemptIdPrefix: `${runId}-manual-review-${Date.now()}`,
        });

        const round = context.currentPlan.version;
        const journal = await Journal.open(context.runDir);
        try {
          const fenceEpoch = (await loadRunState(context.runDir)).fenceEpoch;
          await journal.append({
            runId,
            fenceEpoch,
            kind: "critique_independent",
            planId: context.currentPlan.planId,
            round,
            assessmentJson: JSON.stringify(result.assessment),
          });
          await journal.append({
            runId,
            fenceEpoch,
            kind: "critique_objections",
            planId: context.currentPlan.planId,
            round,
            objectionsJson: JSON.stringify({ objections: result.objections }),
          });
        } finally {
          await journal.close();
        }

        const objectionsJson = JSON.stringify(
          {
            objections: result.objections,
            unresolved: result.objections.filter((objection) => objection.resolution !== "accepted"),
          },
          null,
          2,
        );
        await persistPlanVersion({
          runId,
          context,
          plan: result.revisedPlan,
          objectionsJson,
          round,
          attemptId: `${runId}-manual-review`,
        });
        await recordPlanOperation({ runId, operation: "codex_review", transition: "success" });
      } catch (err) {
        await recordPlanOperation({
          runId,
          operation: "codex_review",
          transition: "failed",
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
      }
    },
  }).catch(async (err) => {
    const message = err instanceof OutputLockConflict ? "another plan operation is already running" : err instanceof Error ? err.message : String(err);
    await recordPlanOperation({ runId, operation: "codex_review", transition: "failed", error: message }).catch(() => undefined);
  });

  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("notice", "Codex is reviewing the plan, then Claude will refine it in the same session.");
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
