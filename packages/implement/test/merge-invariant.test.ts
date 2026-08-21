import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Project invariant (see CLAUDE.md: "no code path may merge one" / pr.ts's
 * module doc comment): `mergePr` exists on `GhClient` ONLY so the
 * credential-scope boundary is provable by tests -- it must never gain a
 * caller in this package's own (non-test) source. `GhClient.mergePr`'s
 * *definitions* (`RealGhClient`/`AmbientGhClient`/`LocalGhStub`) are exempt
 * -- this checks for CALL sites (`.mergePr(`), not the interface/method
 * declarations that implement it.
 */
test("mergePr has no non-test caller anywhere in packages/implement/src", async () => {
  const files = await readdir(SRC_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const full = path.join(SRC_DIR, file);
    const content = await readFile(full, "utf8");
    for (const line of content.split("\n")) {
      // A call site looks like `something.mergePr(...)`. A method
      // *declaration* (`mergePr(cred: ..., pr: ...): Promise<void> {` or
      // the interface signature ending in `;`) has no `.` immediately
      // before `mergePr` -- that's the distinguishing shape we grep for.
      if (/\.mergePr\s*\(/.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `mergePr must have no non-test caller in packages/implement/src:\n${offenders.join("\n")}`);
});
