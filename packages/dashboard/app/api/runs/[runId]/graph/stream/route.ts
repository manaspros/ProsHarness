/**
 * B9 piece 4 -- an SSE endpoint that tails a run's session graph so the
 * graph page (app/runs/[runId]/graph/page.tsx) can update live instead of
 * only at page load. Deliberately reuses `loadSessionGraph`
 * (lib/graph-data.ts -> @pros/graph's `buildSessionGraph`) rather than
 * re-parsing raw.log itself -- the exact "do not rebuild it" instruction
 * for this piece. `rebuildAndOpenIndex` (lib/db.ts) IS the thing that reads
 * raw.log off disk (via @pros/index's rebuildIndex); polling it on an
 * interval is how this route "tails" the log without a second, competing
 * file-watching implementation.
 *
 * No new dependency: Next.js route handlers can return a raw
 * `ReadableStream` as the Response body, which is all SSE needs -- no
 * `EventSource` polyfill or SSE library required server-side.
 *
 * Edge cases this route is responsible for (see the phase-7 brief):
 *   - client disconnect: the stream's `cancel()` callback clears the
 *     interval timer. Without this, an abandoned browser tab would leak an
 *     interval (and its rebuildIndex/db-open work) forever.
 *   - a run whose raw.log/journal doesn't exist yet: `loadRunState` and
 *     `rebuildAndOpenIndex` both already tolerate a missing run directory
 *     (loadRunState via barrier's own "no journal yet" handling,
 *     rebuildIndex by producing an empty index) -- this route sends an
 *     empty graph rather than erroring.
 *   - log rotation/truncation: already @pros/index's job (RebuildReport's
 *     `truncatedRuns`/`rawLogParseIssues`) every time this route re-runs
 *     rebuildIndex on its poll tick -- nothing new needed here.
 *   - a run that ends mid-stream: once no attempt is still running (no
 *     AttemptRecord with `endedReason === undefined`), this route sends one
 *     final "done" event and closes the stream itself, so a client doesn't
 *     have to keep an EventSource open against a run that will never
 *     change again.
 */
import path from "node:path";
import { loadRunState } from "@pros/barrier";
import { getRunsRoot, getIndexDbPath } from "../../../../../../lib/config";
import { rebuildAndOpenIndex } from "../../../../../../lib/db";
import { loadSessionGraph } from "../../../../../../lib/graph-data";

export const dynamic = "force-dynamic";

/** How often to re-check for new graph nodes. Fast enough to feel "live" without hammering the SQLite rebuild on every tick (same cost shape @pros/schedule's own polling jobs already accept -- see packages/schedule/src/jobs.ts's job-interval doc comments for the same "how often is often enough" reasoning applied elsewhere in this repo). */
const POLL_INTERVAL_MS = 1500;

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await ctx.params;
  const runsRoot = getRunsRoot();
  const dbPath = getIndexDbPath();
  const runDir = path.join(runsRoot, runId);

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const finish = () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting -- fine, nothing left to do.
        }
      };

      let lastNodeCount = -1;
      const tick = async (): Promise<void> => {
        if (closed) return;

        let handle: Awaited<ReturnType<typeof rebuildAndOpenIndex>> | undefined;
        try {
          handle = await rebuildAndOpenIndex(dbPath, runsRoot);
          const graph = loadSessionGraph(handle.db, runId);
          if (graph.nodes.length !== lastNodeCount) {
            lastNodeCount = graph.nodes.length;
            if (!closed) controller.enqueue(encoder.encode(sseLine("graph", graph)));
          }
        } catch (err) {
          if (!closed) controller.enqueue(encoder.encode(sseLine("error", { message: err instanceof Error ? err.message : String(err) })));
          return;
        } finally {
          handle?.db.close();
        }

        // A missing journal (run not created yet, or already reaped) means
        // loadRunState throws/returns an empty state -- either way, "no
        // running attempt" is the correct read, and the stream can close.
        const state = await loadRunState(runDir).catch(() => undefined);
        const stillRunning = state ? [...state.attempts.values()].some((a) => a.endedReason === undefined) : false;
        if (!stillRunning) {
          if (!closed) controller.enqueue(encoder.encode(sseLine("done", { runId })));
          finish();
        }
      };

      void tick();
      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    },
    cancel() {
      // The client (browser tab closed, EventSource aborted) disconnected --
      // this is the leak this route must not have: no lingering interval.
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
