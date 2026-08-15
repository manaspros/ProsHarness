/**
 * POST /api/runs/[runId]/plan/direct-run
 *
 * The plan page's right-rail "composer" lets a human type a free-text
 * instruction and fire it at the plan directly. This milestone does NOT
 * wire that instruction to a live re-planning/execution pipeline -- doing
 * so would mean spawning a real model session or attempt from inside a
 * Next.js request handler, which is a heavier pipeline concern (see
 * packages/plan/src/pipeline.ts, packages/implement/src/pipeline.ts) that
 * this change has no business reaching into half-wired. Faking a "launched"
 * response without actually launching anything would violate the project's
 * "never look healthy when it isn't" invariant.
 *
 * Instead, this durably records the instruction using the exact same
 * tolerant convention @pros/implement's pipeline.ts uses for its own
 * loosely-typed journal entries (verify_verdict, review_completed,
 * pr_create_intent/pr_created -- see that file's doc comment): append an
 * entry whose `kind` is NOT a member of @pros/barrier's JournalEntry union,
 * cast through `as any` at the call site. packages/index/src/rebuild.ts
 * indexes every journal entry into the `events` table unconditionally
 * BEFORE its kind-specific switch, so an unrecognized kind here is not an
 * error -- it's simply preserved verbatim and surfaced by the run
 * overview's "unknown journal kind" health check (see
 * app/runs/[runId]/page.tsx / lib/health.ts), same as those entries are.
 *
 * Accepts a plain HTML form POST or a JSON body: `{ instruction,
 * requestedBy?, redirectTo? }`.
 */
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { Journal, loadRunState } from "@pros/barrier";
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

  const { redirectTo } = body;
  const instruction = body.instruction?.trim();
  const requestedBy = body.requestedBy?.trim() || "human";
  if (!instruction) {
    return respondError(req, redirectTo, 400, "instruction text is required");
  }

  const journal = await Journal.open(runDir);
  try {
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;
    await journal.append({
      runId,
      fenceEpoch,
      kind: "direct_run_requested",
      instruction,
      requestedAt: new Date().toISOString(),
      requestedBy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  } catch (err: any) {
    return respondError(req, redirectTo, 500, `could not record instruction: ${err?.message ?? String(err)}`);
  } finally {
    await journal.close();
  }

  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set(
      "notice",
      "Instruction recorded -- TODO: wiring this to a live pipeline run is a follow-up. Nothing was actually executed.",
    );
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ ok: true, recorded: true, wired: false });
}

function respondError(req: NextRequest, redirectTo: string | undefined, status: number, message: string): NextResponse {
  if (redirectTo) {
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json({ error: message }, { status });
}
