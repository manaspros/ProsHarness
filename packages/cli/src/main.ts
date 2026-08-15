#!/usr/bin/env node
import { runAnswerCommand } from "./answer.js";
import { runPlanCommand } from "./plan.js";
import { runReconcileCommand } from "./reconcile.js";
import { runScheduleCommand } from "./schedule.js";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "answer": {
      const result = await runAnswerCommand(rest);
      console.log(result);
      break;
    }
    case "plan": {
      const result = await runPlanCommand(rest);
      console.log(result);
      break;
    }
    case "reconcile": {
      const result = await runReconcileCommand(rest);
      console.log(result);
      break;
    }
    case "schedule": {
      const result = await runScheduleCommand(rest);
      console.log(result);
      break;
    }
    default:
      console.error(
        [
          "usage: pros answer <question-id> <choice> [--effect=continue_within_approved_plan|requires_plan_amendment|abort]",
          '       pros plan <repoRoot> "<description>" [--run-id=<id>]',
          "       pros reconcile [--stale-after=<ms>]",
          "       pros schedule start [--interval=<pollIntervalMs>]",
          "       pros schedule status",
        ].join("\n"),
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
