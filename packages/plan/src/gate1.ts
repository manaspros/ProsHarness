import path from "node:path";
import { Journal, loadRunState } from "@pros/barrier";
import { writeFileAtomic } from "./pipeline.js";

export interface EditPlanDocumentOptions {
  runDir: string;
  runId: string;
  planId: string;
  version: number;
  markdown: string;
  editedBy: string;
  note?: string;
}

/**
 * Rewrites the run's plan.md IN PLACE and durably records the edit in the
 * journal, WITHOUT touching the fence epoch, without appending any
 * attempt_started/resuming entry, and without requiring the checkpoint to be
 * un-parked first. This is the mechanism behind M3's explicit acceptance
 * criterion: "Plan editing changes the document without restarting the
 * run."
 *
 * Safe to call while a run is parked awaiting Gate 1 approval (the normal
 * case) -- a human can revise wording, add a missing step, etc, and the
 * dashboard shows the new text immediately, with the SAME run/checkpoint/
 * fence state as before.
 */
export async function editPlanDocument(opts: EditPlanDocumentOptions): Promise<void> {
  const journal = await Journal.open(opts.runDir);
  try {
    const fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "plan_edited",
      planId: opts.planId,
      version: opts.version,
      markdown: opts.markdown,
      editedBy: opts.editedBy,
      note: opts.note,
    });

    // Reuse pipeline.ts's exact atomic-write discipline (temp-write + fsync
    // + rename + fsync dir) rather than duplicate it.
    const planPath = path.join(opts.runDir, "plan.md");
    await writeFileAtomic(planPath, opts.markdown);
  } finally {
    await journal.close();
  }
}
