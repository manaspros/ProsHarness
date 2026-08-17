import path from "node:path";
import { Journal, loadRunState, type PlanOperation } from "@pros/barrier";
import { getRunsRoot } from "./config";
import type { Gate2PipelineResultLike } from "./gate2";

export async function recordPlanOperation(opts: {
  runsRoot?: string;
  runId: string;
  operation: PlanOperation;
  transition: "started" | "success" | "failed";
  requestedBy?: string;
  dangerouslySkipPermissions?: boolean;
  error?: string;
  result?: Gate2PipelineResultLike;
}): Promise<void> {
  const runsRoot = opts.runsRoot ?? getRunsRoot();
  const runDir = path.join(runsRoot, opts.runId);
  const journal = await Journal.open(runDir);
  try {
    const fenceEpoch = (await loadRunState(runDir)).fenceEpoch;
    if (opts.transition === "started") {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "plan_operation_started",
        operation: opts.operation,
        requestedBy: opts.requestedBy,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      });
    } else {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "plan_operation_completed",
        operation: opts.operation,
        outcome: opts.transition,
        error: opts.error,
        result: opts.result,
      } as any);
    }
  } finally {
    await journal.close();
  }
}
