/**
 * POST /api/runs/[runId]/plan/edit
 *
 * Calls @pros/plan's editPlanDocument -- the ONLY mechanism for "plan
 * editing changes the document without restarting the run" (see
 * packages/plan/src/gate1.ts's doc comment). Deliberately does NOT touch the
 * Barrier/checkpoint machinery at all: this must work whether or not a
 * checkpoint is currently parked.
 *
 * Accepts either a plain HTML form POST (application/x-www-form-urlencoded,
 * so the page works with zero client-side JS) or a JSON body, per the
 * brief's documented shape `{ planId, version, markdown, editedBy }`.
 */
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { editPlanDocument } from "@pros/plan";
import { getRunsRoot } from "../../../../../../lib/config";

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const { runId } = await ctx.params;
  const runsRoot = getRunsRoot();
  const runDir = path.join(runsRoot, runId);

  let body: Record<string, string>;
  try {
    body = await parseBody(req);
  } catch (err: any) {
    return NextResponse.json({ error: `could not parse request body: ${err?.message ?? err}` }, { status: 400 });
  }

  const { planId, version, markdown, editedBy, note, redirectTo } = body;
  if (!planId || version === undefined || markdown === undefined || !editedBy) {
    return respondError(req, redirectTo, 400, "planId, version, markdown, and editedBy are all required");
  }
  const versionNum = Number(version);
  if (!Number.isFinite(versionNum)) {
    return respondError(req, redirectTo, 400, `version must be a number, got ${version}`);
  }

  try {
    await editPlanDocument({
      runDir,
      runId,
      planId,
      version: versionNum,
      markdown,
      editedBy,
      note: note || undefined,
    });
  } catch (err: any) {
    return respondError(req, redirectTo, 500, `editPlanDocument failed: ${err?.message ?? String(err)}`);
  }

  if (redirectTo) {
    return NextResponse.redirect(new URL(redirectTo, req.url), { status: 303 });
  }
  return NextResponse.json({ ok: true, markdown });
}

function respondError(req: NextRequest, redirectTo: string | undefined, status: number, message: string): NextResponse {
  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ error: message }, { status });
}
