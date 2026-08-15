import { runMining, resolveHistoryRoot, writeMiningOutput } from "@pros/miner";
import { NextResponse } from "next/server";

import { getMinerOutDir } from "../../../../lib/loops-data";
import { OutputLockConflict, withOutputLock } from "../../../../lib/output-lock";

export const runtime = "nodejs";

/** POST /api/loops/regenerate -- mine local Claude history into PROS_MINER_OUT. */
export async function POST(): Promise<NextResponse> {
  const outDir = getMinerOutDir();

  try {
    const result = await withOutputLock({
      outDir,
      operation: "miner",
      run: () => {
        const output = runMining(resolveHistoryRoot());
        writeMiningOutput(output, outDir);
        // Deliberately return counts only: mined quotes/content never enter a
        // response body or stdout.
        return { generatedAt: output.generatedAt, proposalCount: output.proposals.length };
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    if (error instanceof OutputLockConflict) {
      return NextResponse.json({ ok: false, error: "Mining is already running." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "Mining failed.", message: errorMessage(error) }, { status: 500 });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
