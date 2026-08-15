import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dirname, "..", "src");
const FORBIDDEN_SUBSTRINGS = ["fetch(", "http.request", "https.get", "https.request"];

test("src/*.ts never contains network-call substrings (belt-and-suspenders static check)", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "expected src/*.ts files to exist");

  for (const file of files) {
    const content = readFileSync(path.join(SRC_DIR, file), "utf8");
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      assert.ok(!content.includes(forbidden), `${file} must not contain "${forbidden}"`);
    }
  }
});
