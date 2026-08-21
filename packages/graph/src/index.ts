export * from "./graph.js";
// Re-exported so @pros/dashboard (which already depends on @pros/graph for
// the session graph page, not @pros/adapters directly) can derive B9's
// hook-based activity state without a new direct dependency edge -- see
// packages/adapters/src/hook-catalog.ts for the implementation.
export {
  applyHookEvent,
  extractHookEvent,
  foldHookEvents,
  buildHookSpawnExtraArgs,
  HOOK_EVENT_CATALOG,
  type ActivityLabel,
  type ActivityState,
  type HookEventName,
  type HookLifecycleEvent,
} from "@pros/adapters";
