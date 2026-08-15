import { existsSync } from "node:fs";
import { Journal, loadRunState } from "@pros/barrier";

/**
 * The `PostToolUse` / `ExitPlanMode` hook.
 *
 * A standalone script meant to be configured as a Claude Code `PostToolUse`
 * hook (matcher: tool name `ExitPlanMode`) on a SPAWNED session's own Claude
 * Code settings (not this repo's own `.claude/settings.json` -- this hook
 * fires inside sessions that `pros` spawns as subprocesses), corroborating
 * that a plan was actually produced.
 *
 * Critical design constraint, non-negotiable: this hook payload is
 * corroborating evidence ONLY, never authoritative. A missing or malformed
 * payload must degrade gracefully -- never crash the hook, never block the
 * agent's turn, never affect whether Gate 1 actually parks the run. That is
 * exclusively `submit_plan`'s job (see submit-plan.ts). A run's
 * plan-approval state is determined ENTIRELY by
 * checkpoint_requested/parked/answered journal entries -- this hook has no
 * code path that could create one.
 *
 * The well-established (community-observed, not officially documented by
 * Anthropic) PostToolUse hook JSON shape:
 *   {
 *     "session_id": "abc123",
 *     "transcript_path": "/path/to/transcript.jsonl",
 *     "cwd": "/path/to/project",
 *     "hook_event_name": "PostToolUse",
 *     "tool_name": "ExitPlanMode",
 *     "tool_input": { "plan": "# markdown plan text..." },
 *     "tool_response": { "plan": "# markdown plan text...", "isAgentPlan": true }
 *   }
 */

export interface HookValidationResult {
  valid: boolean;
  reason: string | null;
  sessionId: string | null;
  cwd: string | null;
  planMarkdown: string | null;
}

const invalid = (reason: string): HookValidationResult => ({
  valid: false,
  reason,
  sessionId: null,
  cwd: null,
  planMarkdown: null,
});

/** Pure function: parse+validate a raw hook payload string. Never throws. */
export function validateExitPlanModePayload(raw: string): HookValidationResult {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalid("malformed JSON: payload is not a JSON object");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return invalid("malformed JSON");
  }

  // Defensive, type-checked extraction of sessionId/cwd regardless of
  // whether the payload turns out to be a valid ExitPlanMode call -- best
  // effort to preserve whatever corroborating context is present, since this
  // is untrusted input crossing a process boundary.
  const sessionId = typeof obj["session_id"] === "string" ? (obj["session_id"] as string) : null;
  const cwd = typeof obj["cwd"] === "string" ? (obj["cwd"] as string) : null;

  if (obj["hook_event_name"] !== "PostToolUse") {
    return { valid: false, reason: "wrong hook_event_name", sessionId, cwd, planMarkdown: null };
  }
  if (obj["tool_name"] !== "ExitPlanMode") {
    return { valid: false, reason: "wrong tool_name", sessionId, cwd, planMarkdown: null };
  }

  const toolInput = obj["tool_input"];
  const plan =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)["plan"]
      : undefined;
  if (typeof plan !== "string" || plan.length === 0) {
    return { valid: false, reason: "missing tool_input.plan", sessionId, cwd, planMarkdown: null };
  }

  return { valid: true, reason: null, sessionId, cwd, planMarkdown: plan };
}

/** Cap on how much of the raw payload gets durably journaled, so a huge plan doesn't bloat the journal disproportionately. */
const RAW_EXCERPT_MAX_LEN = 20000;

export interface RecordHookPayloadOptions {
  runDir: string;
  runId: string;
  raw: string;
}

/**
 * Appends a `hook_payload_received` journal entry. NEVER throws -- on any
 * internal error (journal write failure, missing runDir, etc), logs to
 * stderr and resolves anyway, because this must never be allowed to affect
 * the run or block the agent whose hook invoked this script.
 */
export async function recordHookPayload(opts: RecordHookPayloadOptions): Promise<void> {
  try {
    // If the run dir doesn't exist yet (e.g. the hook fired before the
    // run's journal was ever opened, or was misconfigured to point
    // somewhere stale), skip recording entirely rather than creating it as
    // a side effect -- Journal.open()/loadRunState() would otherwise
    // silently mkdir it (Journal.read tolerates ENOENT rather than
    // throwing), which is not "gracefully doing nothing", it's fabricating
    // a run directory that was never meant to exist.
    if (!existsSync(opts.runDir)) {
      console.error(`exit-plan-mode-hook: run dir ${opts.runDir} does not exist, skipping record`);
      return;
    }

    const result = validateExitPlanModePayload(opts.raw);

    let fenceEpoch: number;
    try {
      fenceEpoch = (await loadRunState(opts.runDir)).fenceEpoch;
    } catch (err) {
      console.error("exit-plan-mode-hook: could not load run state, skipping record:", err);
      return;
    }

    const journal = await Journal.open(opts.runDir);
    try {
      await journal.append({
        runId: opts.runId,
        fenceEpoch,
        kind: "hook_payload_received",
        hookName: "PostToolUse:ExitPlanMode",
        sessionId: result.sessionId,
        cwd: result.cwd,
        valid: result.valid,
        reason: result.reason,
        rawJsonExcerpt: opts.raw.slice(0, RAW_EXCERPT_MAX_LEN),
      });
    } finally {
      await journal.close();
    }
  } catch (err) {
    console.error("exit-plan-mode-hook: recordHookPayload failed, ignoring:", err);
  }
}

/** Reads all of stdin into a string. Resolves with "" if stdin is empty/closed immediately. */
async function readStdin(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const finish = () => resolve(data);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", finish);
    stream.on("error", finish);
    // Reasonable fallback in case stdin is a TTY or never closes: don't hang
    // the hook process indefinitely.
    setTimeout(finish, 2000).unref();
  });
}

async function main(): Promise<void> {
  try {
    const runDir = process.env.PROS_RUN_DIR;
    const runId = process.env.PROS_RUN_ID;
    if (!runDir || !runId) {
      console.error("exit-plan-mode-hook: PROS_RUN_DIR/PROS_RUN_ID not set -- hook not configured for this session, skipping");
      return;
    }

    const raw = await readStdin(process.stdin);
    await recordHookPayload({ runDir, runId, raw });
  } catch (err) {
    console.error("exit-plan-mode-hook: unexpected error, ignoring:", err);
  } finally {
    // This hook must never cause Claude Code to treat the tool call as
    // blocked or the turn as failed, regardless of what happened above.
    process.exit(0);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(() => process.exit(0));
}
