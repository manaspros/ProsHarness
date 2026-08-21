/**
 * B9's only I/O for liveness: `stat` the running attempt's raw.log,
 * deliberately NOT routed through @pros/index or the journal (see
 * run-status.ts's `deriveLiveness` doc comment for why -- this is a pure
 * read of an ephemeral filesystem fact, not durable state).
 *
 * Kept in its OWN file, separate from lib/board-data.ts, because
 * board-data.ts's pure types (`BoardStage` etc.) are imported by a
 * "use client" component (components/board/BoardClient.tsx) -- any
 * `node:fs` import in that file breaks the client bundle (`pnpm run
 * build` fails with a webpack `UnhandledSchemeError` on `node:fs/promises`
 * otherwise). This file is imported only from server components/routes.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * A missing file (attempt just spawned, hasn't written its first line yet;
 * or the run has no running attempt at all) is not an error -- it's the
 * same "n/a" case `deriveLiveness` already handles for `undefined`.
 */
export async function getRawLogMtimeMs(runDir: string, attemptId: string): Promise<number | undefined> {
  try {
    const stats = await stat(path.join(runDir, "attempts", attemptId, "raw.log"));
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}
