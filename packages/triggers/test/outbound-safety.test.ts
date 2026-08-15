import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Belt-and-suspenders static check, deliberately redundant with "we simply
 * never wrote such a function": read each src/sources/*.ts file's raw text
 * and assert it contains no substring associated with posting/writing to
 * the external service (Slack chat.postMessage, Linear GraphQL mutations,
 * generic "createComment"/"reply" style writes). This does not prove
 * absence of ALL possible write paths, but it catches the obvious ones and
 * acts as a tripwire if someone adds an outbound call without noticing
 * they've broken the read-only contract documented in each file's banner.
 */

const FORBIDDEN_SUBSTRINGS = [
  "chat.postMessage",
  "chat.post",
  "postMessage(",
  "createComment",
  "mutation ", // Linear/GraphQL mutations, note the trailing space to avoid matching the word "mutation" in comments
  "conversations.reply",
  "reactions.add",
  "files.upload",
];

test("no source adapter contains an outbound write/post call", async () => {
  const sourcesDir = path.join(import.meta.dirname, "..", "src", "sources");
  const files = (await readdir(sourcesDir)).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 4, "expected at least 4 source adapter files");

  for (const file of files) {
    const contents = await readFile(path.join(sourcesDir, file), "utf8");
    // Also require the READ-ONLY ADAPTER banner is present.
    assert.match(contents, /READ-ONLY ADAPTER/, `${file} must carry the READ-ONLY ADAPTER banner`);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      assert.ok(
        !contents.includes(forbidden),
        `${file} must not contain outbound-write substring "${forbidden}"`,
      );
    }
  }
});
