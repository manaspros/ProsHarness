// B9 piece 3 ("hook-driven activity state"): a scoped-per-spawn Claude Code
// hook catalog, plus the pure logic to turn the resulting hook lifecycle
// events (surfaced via `--include-hook-events`, verified live against a real
// `claude` CLI invocation -- see the phase-7 notes) into an order-tolerant
// per-attempt activity label.
//
// SCOPING (load-bearing, per CLAUDE.md's "do not modify the user's global
// settings"): this module builds a `--settings <json-string>` CLI argument
// and an `--include-hook-events` flag, both consumed only by the single
// `spawnClaude` invocation they're passed to (packages/plan/src/
// real-sessions.ts's `RealClaudeSession.run`, the one call site every
// harness stage funnels through). Nothing here writes to, or is loaded
// from, `~/.claude/settings.json` or any project/local settings file --
// verified empirically with `--setting-sources ""` (isolates from user/
// project/local settings; --settings still layers on top; see the phase-7
// evidence dump for the exact command/output) that this JSON is the ONLY
// source of hook registration in scope. Hook commands are trivial no-ops
// (`true`) -- their only job is to make the CLI *emit* the lifecycle event
// into the stream-json output we already tee to raw.log; nothing external
// needs to run.
//
// WHY NOT rely on ambient hooks already configured on the machine: verified
// live that an org/managed-policy hook layer can still fire even under
// `--setting-sources ""` (it sits above user/project/local), which means an
// install with no ambient hooks at all would see NOTHING without this --
// exactly the gap this module closes.

export const HOOK_EVENT_CATALOG = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENT_CATALOG)[number];

/** No matcher restricts these to "every tool"/"every prompt" -- the whole point is coverage, not filtering. */
function hookEntry(): { hooks: Array<{ type: "command"; command: string }> } {
  return { hooks: [{ type: "command", command: "true" }] };
}

/**
 * Builds the `--settings` JSON payload registering a no-op command hook for
 * every catalog event. Exported separately from the extraArgs helper below
 * so a test can assert on the exact shape without re-parsing argv.
 */
export function buildHookSettingsJson(): string {
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENT_CATALOG) {
    hooks[event] = [{ matcher: "*", ...hookEntry() }];
  }
  return JSON.stringify({ hooks });
}

/**
 * The full extraArgs a `spawnClaude` caller appends to opt into hook-derived
 * activity state for that one spawn. Wrapped so a JSON.stringify failure
 * (there is none possible here -- the payload is static -- but this keeps
 * the contract "never throws" honest for callers that build extraArgs in a
 * hot path) degrades to no extra args rather than crashing a real run.
 */
export function buildHookSpawnExtraArgs(): string[] {
  try {
    return ["--include-hook-events", "--settings", buildHookSettingsJson()];
  } catch {
    return [];
  }
}

export type ActivityLabel = "starting" | "working" | "blocked" | "idle" | "stopped";

export interface HookLifecycleEvent {
  /** The raw.log line's own seq (ParsedEvent.seq) -- monotonic per attempt by construction (one append-only stream), which is what makes seq-gated last-writer-wins safe even when hook_started/hook_response pairs interleave unpredictably. */
  seq: number;
  hookEvent: HookEventName | string;
  subtype: "hook_started" | "hook_response";
}

export interface ActivityState {
  seq: number;
  label: ActivityLabel;
  updatedAt: string;
}

/** Coarse mapping used only for hook_started (the moment we know what KIND of thing began); hook_response of the same event doesn't change the label -- see applyHookEvent's doc comment for why blocked's resolution is intentionally approximate. */
const STARTED_LABEL: Partial<Record<HookEventName, ActivityLabel>> = {
  SessionStart: "starting",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "working",
  PermissionRequest: "blocked",
  Notification: "working",
  Stop: "idle",
  SubagentStop: "working",
  SessionEnd: "stopped",
};

/**
 * Order-tolerant reducer -- the part explicitly warned about upstream
 * (agent-orchestrator's PR #5 reverted a naive event-to-state mapping over a
 * race where events arrived out of order). The guard is exactly one
 * inequality: an event whose seq is not strictly greater than the state
 * already applied can never move the state backwards. This holds even
 * across concurrent tool calls or hook callbacks completing in a different
 * order than they started, because seq is assigned by the raw.log tee at
 * append time (packages/adapters/src/spawn-common.ts), not by the hook
 * callback's own completion order.
 *
 * Approximation, stated plainly: PermissionRequest's hook_started sets
 * "blocked" immediately (a pending permission prompt IS a wedge from this
 * run's point of view, whether or not it ever resolves). The NEXT hook
 * event of any kind (typically the PreToolUse/PostToolUse for whatever the
 * human approved, or SessionEnd if they didn't) clears it back to that
 * event's own label. This module does not correlate hook_id-level
 * request/response pairs for anything other than "did some later event
 * happen" -- a full replay would need that, but for a liveness signal
 * ("is a human's attention needed right now") coarseness here is the right
 * trade-off against the complexity of id-keyed state.
 */
export function applyHookEvent(prev: ActivityState | undefined, event: HookLifecycleEvent, now: string = new Date().toISOString()): ActivityState {
  if (prev && event.seq <= prev.seq) return prev;
  if (event.subtype !== "hook_started") {
    // A hook_response never changes the label by itself -- only hook_started
    // tells us what NEW thing began. Still advance seq so a later
    // hook_started can't be rejected as "not newer" due to a skipped gate.
    return { seq: event.seq, label: prev?.label ?? "starting", updatedAt: now };
  }
  const label = STARTED_LABEL[event.hookEvent as HookEventName] ?? prev?.label ?? "working";
  return { seq: event.seq, label, updatedAt: now };
}

/** Extracts a HookLifecycleEvent from one already-parsed adapter line, or undefined if this line isn't a hook lifecycle line at all (the overwhelming majority of lines -- assistant/user/result/tool events -- aren't). */
export function extractHookEvent(parsed: { type?: string; data?: unknown; seq: number }): HookLifecycleEvent | undefined {
  if (parsed.type !== "system" || typeof parsed.data !== "object" || parsed.data === null) return undefined;
  const data = parsed.data as Record<string, unknown>;
  const subtype = data.subtype;
  const hookEvent = data.hook_event;
  if ((subtype !== "hook_started" && subtype !== "hook_response") || typeof hookEvent !== "string") return undefined;
  return { seq: parsed.seq, hookEvent, subtype };
}

/**
 * Folds a list of already-extracted hook events into a final ActivityState,
 * deliberately taking events in WHATEVER order the caller has them (a test
 * can pass them scrambled) rather than assuming the caller already sorted
 * by seq -- applyHookEvent's own seq gate is what makes that safe. Returns
 * undefined if the list is empty (no hook activity observed at all yet).
 */
export function foldHookEvents(events: HookLifecycleEvent[], now: string = new Date().toISOString()): ActivityState | undefined {
  let state: ActivityState | undefined;
  for (const event of events) state = applyHookEvent(state, event, now);
  return state;
}
