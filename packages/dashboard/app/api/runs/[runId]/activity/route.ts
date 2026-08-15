import path from "node:path";
import { NextResponse } from "next/server";
import { getRunsRoot } from "../../../../../lib/config";
import { getSessionActivity } from "../../../../../lib/session-activity";

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const { runId } = await ctx.params;
  return NextResponse.json(await getSessionActivity(path.join(getRunsRoot(), runId)));
}
