/**
 * POST /api/runs/[runId]/checkpoints/[checkpointId]/answer
 *
 * The ONLY write path for approving/rejecting/answering a checkpoint is
 * Barrier.recordAnswer -- this route is a thin wrapper around it. It reads
 * the checkpoint's OWN questionId/idempotencyKey from the barrier's live
 * state (never inventing new ones), and requires the checkpoint to
 * currently be "parked" -- Barrier.recordAnswer enforces that itself and
 * throws StaleAnswerError otherwise, which we map to a 409, not a raw 500.
 */
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { Barrier, StaleAnswerError } from "@pros/barrier";
import { getRunsRoot } from "../../../../../../../lib/config";
import { planActionToEffect, isAnswerEffect, DEFAULT_ANSWER_EFFECT, type PlanApprovalAction } from "../../../../../../../lib/gate-actions";

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await req.json();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json ?? {})) out[k] = String(v);
    return out;
  }
  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string; checkpointId: string }> },
): Promise<NextResponse> {
  const { runId, checkpointId } = await ctx.params;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  let body: Record<string, string>;
  try {
    body = await parseBody(req);
  } catch (err: any) {
    return NextResponse.json({ error: `could not parse request body: ${err?.message ?? err}` }, { status: 400 });
  }

  const redirectTo = body.redirectTo;

  // Effect: a plan-approval button click (planAction) takes priority over an
  // explicit `effect` field, which itself falls back to the default -- see
  // lib/gate-actions.ts.
  let effect;
  if (body.planAction) {
    const action = body.planAction as PlanApprovalAction;
    if (!["approve", "request_amendment", "reject"].includes(action)) {
      return respondError(req, redirectTo, 400, `invalid planAction: ${body.planAction}`);
    }
    effect = planActionToEffect(action);
  } else if (body.effect) {
    if (!isAnswerEffect(body.effect)) {
      return respondError(req, redirectTo, 400, `invalid effect: ${body.effect}`);
    }
    effect = body.effect;
  } else {
    effect = DEFAULT_ANSWER_EFFECT;
  }

  // Free-text answer wins over a selected option, if both are present and
  // free text is non-empty -- matches the Questions page's "options as
  // choices (plus a free-text fallback)" requirement.
  const answer = body.answerFreeText?.trim() ? body.answerFreeText.trim() : (body.answer ?? "");
  if (!answer) {
    return respondError(req, redirectTo, 400, "answer text is required (select an option or fill in the free-text field)");
  }

  const barrier = await Barrier.open(runDir, runId);
  try {
    const cp = barrier.getState().checkpoints.get(checkpointId);
    if (!cp) {
      return respondError(req, redirectTo, 404, `checkpoint ${checkpointId} not found in run ${runId}`);
    }
    await barrier.recordAnswer(checkpointId, cp.questionId, cp.idempotencyKey, answer, effect);
  } catch (err) {
    if (err instanceof StaleAnswerError) {
      return respondError(
        req,
        redirectTo,
        409,
        `checkpoint ${checkpointId} is no longer parked (phase=${err.phase}) -- it was likely already answered or the run moved on; refresh and check its current state`,
      );
    }
    return respondError(req, redirectTo, 500, `recordAnswer failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    await barrier.close();
  }

  if (redirectTo) {
    return NextResponse.redirect(new URL(redirectTo, req.url), { status: 303 });
  }
  return NextResponse.json({ ok: true });
}

function respondError(req: NextRequest, redirectTo: string | undefined, status: number, message: string): NextResponse {
  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ error: message }, { status });
}
