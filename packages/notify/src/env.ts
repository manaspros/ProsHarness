/**
 * Central parsing of `PROS_NOTIFICATIONS_ENABLED` -- the single on/off switch
 * for the notification wiring built in wire-barrier.ts.
 *
 * B8 (docs phase 7): both human gates already call `wireNtfyNotifications`
 * with correct per-gate messages, but every call site
 * (packages/cli/src/{plan,implement,schedule}.ts,
 * packages/implement/src/continue-approved.ts) hardcoded
 * `notificationsEnabled: false` with no flag anywhere that flipped it. This
 * is the flag: matches the repo's existing `PROS_`-prefixed env var
 * convention (see packages/cli/src/schedule.ts's `resolveScheduleDirs` /
 * `buildSources` for the established pattern of reading config straight off
 * `process.env` at the CLI boundary, injectable for tests).
 *
 * Default channel is ntfy (see notify/src/transport.ts's
 * `resolveDefaultSend`): unset `PROS_NTFY_URL` falls back to the Slack-MCP
 * transport, which this phase deliberately does not exercise or newly wire
 * up -- callers that want ntfy specifically should also set `PROS_NTFY_URL`.
 */
export function notificationsEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PROS_NOTIFICATIONS_ENABLED;
  if (v === undefined) return false;
  return v === "1" || v.toLowerCase() === "true";
}
