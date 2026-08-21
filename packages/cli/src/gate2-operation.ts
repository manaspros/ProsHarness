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

/**
 * Keep Gate 2's orchestration fact in the same run journal as the pipeline.
 * The result is intentionally stored as-is on the completion event: an
 * aborted pipeline is a resolved result, not an exception, and the dashboard
 * needs its `aborted` stage/reason to distinguish stopped from failed.
 */
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
      // The barrier event contract uses failed for an aborted pipeline. The
      // stored result is the authoritative distinction between failed and
      // stopped, and remains available to dashboard consumers.
      outcome: stopped || opts.error ? "failed" : "success",
      error: opts.error ?? (stopped ? `Gate 2 stopped during ${stopped.stage}: ${stopped.reason}` : undefined),
      result: opts.result,
    } as any);
  } finally {
    await journal.close();
  }
}
