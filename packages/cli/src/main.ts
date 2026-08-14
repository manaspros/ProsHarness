#!/usr/bin/env node
import { runAnswerCommand } from "./answer.js";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "answer": {
      const result = await runAnswerCommand(rest);
      console.log(result);
      break;
    }
    default:
      console.error("usage: pros answer <question-id> <choice> [--effect=continue_within_approved_plan|requires_plan_amendment|abort]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
