import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Barrier } from "@pros/barrier";
import { registerSubmitPlanTool } from "./submit-plan.js";

/**
 * The `ask_human` MCP tool.
 *
 * The single most important property here, stated plainly because getting it
 * wrong would have cost a week (docs/03-architecture.md): a returning MCP
 * tool call does NOT end the model's turn. The model receives a successful
 * result and simply keeps writing -- another edit, another bash call.
 * `ask_human` therefore must never resolve with success. It durable-appends
 * the checkpoint intent (step 1 of the barrier sequence) and then the
 * *daemon* -- via Barrier.requestCheckpoint, which freezes and kills this
 * very attempt's containment boundary -- ends the attempt with the call
 * still in flight. The handler below deliberately never returns; the
 * process is killed out from under it.
 *
 * Configuration is via environment variables, because this server is
 * spawned per-attempt by the launch config (`--mcp-config`) and has no
 * other channel to learn which run/attempt it belongs to:
 *   PROS_RUN_DIR    - the run's durable directory (contains journal.ndjson)
 *   PROS_RUN_ID     - the run id
 *   PROS_ATTEMPT_ID - the attempt id this server instance is scoped to
 */

export interface AskHumanEnv {
  runDir: string;
  runId: string;
  attemptId: string;
}

export function readAskHumanEnv(env: NodeJS.ProcessEnv = process.env): AskHumanEnv {
  const runDir = env.PROS_RUN_DIR;
  const runId = env.PROS_RUN_ID;
  const attemptId = env.PROS_ATTEMPT_ID;
  if (!runDir || !runId || !attemptId) {
    throw new Error("ask_human requires PROS_RUN_DIR, PROS_RUN_ID and PROS_ATTEMPT_ID in the environment");
  }
  return { runDir, runId, attemptId };
}

export interface AskHumanInput {
  prompt: string;
  options: string[];
  idempotencyKey?: string;
}

/**
 * The actual `ask_human` behavior, factored out of the MCP tool registration
 * so it can be exercised directly in tests without a stdio transport.
 *
 * Deliberately returns `Promise<never>` -- it is not just unresolved *in
 * practice*, the type says a caller must never expect a value out of it.
 */
export function askHuman(barrier: Barrier, attemptId: string, input: AskHumanInput): Promise<never> {
  const questionId = randomUUID();
  const key = input.idempotencyKey ?? questionId;

  // Step 1 of the barrier sequence happens inside requestCheckpoint:
  // durable-append + fsync, then freeze the containment boundary before any
  // successful response could reach the model, confirm emptiness, snapshot
  // the manifest, and durable-append `parked`.
  const checkpointPromise = barrier.requestCheckpoint({
    attemptId,
    questionId,
    idempotencyKey: key,
    prompt: input.prompt,
    options: input.options,
  });

  return checkpointPromise.then(
    () => new Promise<never>(() => {}),
    () => new Promise<never>(() => {}),
  );
  // By the time requestCheckpoint resolves, this attempt's containment
  // boundary has already been killed -- including, ordinarily, this very
  // process. Even on failure to checkpoint, this must not resolve with
  // something the model could act on: there must be no code path where a
  // successful tool result reaches the model.
}

/**
 * Builds the single `pros` MCP server process/instance exposing BOTH
 * `ask_human` and `submit_plan`, sharing one Barrier and one attemptId. Kept
 * under the original name (`createAskHumanServer`) so nothing that already
 * references it breaks -- see also the `createProsMcpServer` alias below.
 */
export async function createAskHumanServer(barrier: Barrier, attemptId: string): Promise<McpServer> {
  const server = new McpServer({ name: "pros-mcp", version: "0.0.0" });

  server.registerTool(
    "ask_human",
    {
      description:
        "Ask the human a question and PARK this run. This call never returns -- the process ends while the call is in flight. Do not expect a response; do not perform further actions after calling this.",
      inputSchema: {
        prompt: z.string().describe("The question to show the human."),
        options: z.array(z.string()).default([]).describe("Suggested answer choices, if any."),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Caller-supplied dedup key. A replay with the same key is guaranteed to resolve to the same question, never a second one."),
      },
    },
    ({ prompt, options, idempotencyKey }) => askHuman(barrier, attemptId, { prompt, options, idempotencyKey }),
  );

  registerSubmitPlanTool(server, barrier, attemptId);

  return server;
}

/** Alias -- the name describes what this now is (one server, multiple gate tools) better than the original. */
export const createProsMcpServer = createAskHumanServer;

async function main(): Promise<void> {
  const { runDir, runId, attemptId } = readAskHumanEnv();
  const barrier = await Barrier.open(runDir, runId);
  const server = await createAskHumanServer(barrier, attemptId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("ask-human MCP server failed to start:", err);
    process.exit(1);
  });
}
