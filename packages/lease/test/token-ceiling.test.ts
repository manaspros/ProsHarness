import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenCeiling, TokenCeilingExceededError } from "../src/token-ceiling.js";

test("record() accumulates input+output tokens across multiple calls", () => {
  const ceiling = new TokenCeiling({ maxTotalTokens: 1000 });
  ceiling.record({ inputTokens: 100, outputTokens: 50 });
  assert.equal(ceiling.used(), 150);
  assert.equal(ceiling.remaining(), 850);

  ceiling.record({ inputTokens: 200, outputTokens: 100 });
  assert.equal(ceiling.used(), 450);
  assert.equal(ceiling.remaining(), 550);
});

test("record() throws TokenCeilingExceededError once the cumulative total exceeds the ceiling", () => {
  const ceiling = new TokenCeiling({ maxTotalTokens: 100 });
  ceiling.record({ inputTokens: 50, outputTokens: 40 }); // 90, still under
  assert.throws(
    () => ceiling.record({ inputTokens: 20, outputTokens: 0 }), // 110, over
    (err: unknown) => {
      assert.ok(err instanceof TokenCeilingExceededError);
      assert.equal(err.used, 110);
      assert.equal(err.ceiling, 100);
      return true;
    },
  );
});

test("used() still reflects the over-the-ceiling total after a throw (not rolled back)", () => {
  const ceiling = new TokenCeiling({ maxTotalTokens: 100 });
  ceiling.record({ inputTokens: 90, outputTokens: 0 });
  assert.throws(() => ceiling.record({ inputTokens: 30, outputTokens: 0 }), TokenCeilingExceededError);
  assert.equal(ceiling.used(), 120);
});

test("remaining() floors at 0 once over ceiling", () => {
  const ceiling = new TokenCeiling({ maxTotalTokens: 100 });
  ceiling.record({ inputTokens: 90, outputTokens: 0 });
  assert.throws(() => ceiling.record({ inputTokens: 50, outputTokens: 0 }), TokenCeilingExceededError);
  assert.equal(ceiling.used(), 140);
  assert.equal(ceiling.remaining(), 0);
});
