import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationsEnabledFromEnv } from "../src/env.js";

/**
 * B8 regression: every notificationsEnabled call site used to hardcode
 * `?? false` regardless of what was in the environment, so no flag existed
 * anywhere that could turn notifications on. This is the parser those call
 * sites now defer to -- pin its truthy/falsy contract so a future change to
 * one call site can't silently diverge from the others.
 */
test("notificationsEnabledFromEnv: unset is off", () => {
  assert.equal(notificationsEnabledFromEnv({} as NodeJS.ProcessEnv), false);
});

test("notificationsEnabledFromEnv: accepts '1' and 'true' (any case) as on", () => {
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "TRUE" } as NodeJS.ProcessEnv), true);
});

test("notificationsEnabledFromEnv: any other value (including '0', 'false', 'yes') is off", () => {
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(notificationsEnabledFromEnv({ PROS_NOTIFICATIONS_ENABLED: "yes" } as NodeJS.ProcessEnv), false);
});
