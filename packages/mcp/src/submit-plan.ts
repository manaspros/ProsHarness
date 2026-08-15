import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Barrier } from "@pros/barrier";

/**
 * The `submit_plan` MCP tool -- M3's Gate 1.
 *
 * Structured exactly like `ask_human` (see ask-human.ts's long comment on
 * why): a returning MCP tool call does NOT end the model's turn, so this
 * must never resolve with a value the model could act on, even on
 * `requestCheckpoint` failure. It durable-appends the checkpoint intent
 * (with `gateType: "plan_approval"` and the plan's `planRef`) and then never
 * resolves -- the daemon that owns this attempt's guardian is what actually
 * freezes and kills it, exactly as with `ask_human`.
 */

export interface SubmitPlanInput {
  planId: string;
  version: number;
  /** Short human-readable description of the plan, shown as the checkpoint prompt. */
  summary: string;
  idempotencyKey?: string;
}

export function submitPlan(barrier: Barrier, attemptId: string, input: SubmitPlanInput): Promise<never> {
  const questionId = randomUUID();
  const key = input.idempotencyKey ?? questionId;

  const checkpointPromise = barrier.requestCheckpoint({
    attemptId,
    questionId,
    idempotencyKey: key,
    prompt: `Plan ${input.planId} v${input.version} ready for review:\n\n${input.summary}`,
    options: ["approve", "amend", "reject"],
    gateType: "plan_approval",
    planRef: { planId: input.planId, version: input.version },
  });

  return checkpointPromise.then(
    () => new Promise<never>(() => {}),
    () => new Promise<never>(() => {}),
  );
  // Same discipline as askHuman(): by the time requestCheckpoint resolves,
  // this attempt's containment boundary has ordinarily already been killed.
  // Even on failure to checkpoint, there is no code path here that resolves
  // with something the model could act on.
}

export function registerSubmitPlanTool(server: McpServer, barrier: Barrier, attemptId: string): void {
  server.registerTool(
    "submit_plan",
    {
      description:
        "Submit a plan for human approval (Gate 1) and PARK this run. This call never returns -- the process ends while the call is in flight. Do not expect a response; do not perform further actions after calling this.",
      inputSchema: {
        planId: z.string().describe("The plan's id."),
        version: z.number().describe("Which version of the plan this approval gate concerns."),
        summary: z.string().describe("Short human-readable description of the plan, shown as the checkpoint prompt."),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Caller-supplied dedup key. A replay with the same key is guaranteed to resolve to the same question, never a second one."),
      },
    },
    ({ planId, version, summary, idempotencyKey }) => submitPlan(barrier, attemptId, { planId, version, summary, idempotencyKey }),
  );
}
