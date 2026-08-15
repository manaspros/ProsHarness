/**
 * POST /api/new/scan
 *
 * A sibling to /api/new/launch: this route runs a trigger source's
 * `fetchSignals()` for real and returns the resulting `Signal[]` (or an
 * honest failure message) so `/new`'s form can let a human pick a finding
 * to pre-fill the description textarea with, before separately submitting
 * through the existing manual launch flow (`/api/new/launch` with
 * `source: "manual"`). This route never itself launches a plan run.
 *
 * - `sweep`: `SweepSource` is local-only and credential-free (a plain
 *   filesystem grep for TODO/FIXME/XXX under `repoRoot`) -- always safe to
 *   run, returns `{ ok: true, signals: [] }` honestly when nothing is
 *   found, never throws for "nothing to report."
 * - `linear` / `slack` / `granola`: each source is constructed with NO
 *   `fixturePath` and NO api-key options, so `fetchSignals()` takes the
 *   real MCP path (packages/triggers/src/sources/{linear,slack,granola}.ts)
 *   -- a short-lived, read-only `claude -p` call against the operator's
 *   already-connected MCP server for that service. This spends real
 *   Claude subscription usage. If the MCP server isn't connected (and no
 *   API-key fallback is configured via env), the source throws a specific,
 *   descriptive error, which this route reports back as
 *   `{ ok: false, message }` rather than a generic "not wired up" -- the
 *   whole point being that the failure the user sees here is the *real*
 *   one from the source itself.
 */
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { SweepSource, LinearSource, SlackSource, GranolaSource, type Signal } from "@pros/triggers";

export type ScanSourceId = "sweep" | "linear" | "slack" | "granola";

const SCAN_SOURCES: ScanSourceId[] = ["sweep", "linear", "slack", "granola"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { repoRoot?: string; source?: string };
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `could not parse request body as JSON: ${err?.message ?? err}` }, { status: 400 });
  }

  const source = body.source as ScanSourceId | undefined;
  if (!source || !SCAN_SOURCES.includes(source)) {
    return NextResponse.json({ error: `unknown or missing scan source: ${body.source}` }, { status: 400 });
  }

  if (source === "sweep") {
    const repoRoot = body.repoRoot?.trim() ?? "";
    if (!repoRoot) {
      return NextResponse.json({ error: "repoRoot is required for a sweep scan" }, { status: 400 });
    }
    try {
      const signals = await new SweepSource({ repoRoot: path.resolve(repoRoot) }).fetchSignals();
      return NextResponse.json({ ok: true, signals } satisfies { ok: true; signals: Signal[] });
    } catch (err: any) {
      return NextResponse.json({ ok: false, message: err?.message ?? String(err) });
    }
  }

  // linear / slack / granola: real MCP-first path, no fixturePath/apiKey --
  // exactly as production's trigger daemon would construct these.
  try {
    const signals = await fetchRealSource(source);
    return NextResponse.json({ ok: true, signals } satisfies { ok: true; signals: Signal[] });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err?.message ?? String(err) });
  }
}

async function fetchRealSource(source: "linear" | "slack" | "granola"): Promise<Signal[]> {
  if (source === "linear") return new LinearSource({}).fetchSignals();
  if (source === "slack") return new SlackSource({}).fetchSignals();
  return new GranolaSource({}).fetchSignals();
}
