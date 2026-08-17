import { Journal, loadRunState } from "@pros/barrier";
import type { Gate2PipelineResult } from "@pros/implement";

export interface Gate2OperationEventOptions {
  runId: string;
  runDir: string;
  requestedBy: string;
  transition: "started" | "completed" | "failed";
  result?: Gate2PipelineResult;
  error?: string;
}

/** Journal the scheduler's Gate 2 lifecycle and preserve the resolved result. */
export async function recordGate2Operation(opts: Gate2OperationEventOptions): Promise<void> {
  const journal = await Journal.open(opts.runDir);
  try {
    const fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;
    if (opts.transition === "started") {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "plan_operation_started",
        operation: "implementation",
        requestedBy: opts.requestedBy,
      });
      return;
    }

    const stopped = opts.result?.aborted;
    await journal.append({
      runId: opts.runId,
      fenceEpoch,
      kind: "plan_operation_completed",
      operation: "implementation",
      outcome: stopped || opts.error ? "failed" : "success",
      error: opts.error ?? (stopped ? `Gate 2 stopped during ${stopped.stage}: ${stopped.reason}` : undefined),
      result: opts.result,
    } as any);
  } finally {
    await journal.close();
  }
}
