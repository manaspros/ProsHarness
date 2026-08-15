import { runSkillrank, writeSkillrankOutput } from "@pros/skillrank";
import { NextResponse } from "next/server";

import { getSkillLockFilePath, getSkillrankOutDir } from "../../../../lib/skillrank-data";
import { getMinerOutDir } from "../../../../lib/loops-data";
import { OutputLockConflict, withOutputLock } from "../../../../lib/output-lock";

export const runtime = "nodejs";

/**
 * POST /api/skills/regenerate -- generate local skill proposals only.
 * Nothing here installs or edits skill-registry-lock.json.
 */
export async function POST(): Promise<NextResponse> {
  const outDir = getSkillrankOutDir();

  try {
    const result = await withOutputLock({
      outDir,
      operation: "skillrank",
      run: () => {
        const file = runSkillrank({
          lockFilePath: getSkillLockFilePath(),
          minerOutDir: getMinerOutDir(),
          outDir,
        });
        writeSkillrankOutput(file, outDir);
        return { generatedAt: file.generatedAt, proposalCount: file.proposals.length };
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    if (error instanceof OutputLockConflict) {
      return NextResponse.json({ ok: false, error: "Skill proposal generation is already running." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "Skill proposal generation failed.", message: errorMessage(error) }, { status: 500 });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
