import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("no-network: src/ never imports network modules or calls fetch()", async () => {
  const srcDir = path.join(__dirname, "../src");
  const bannedPatterns = [
    /node-fetch/,
    /undici/,
    /from ["']http["']/,
    /from ["']https["']/,
    /from ["']node:http["']/,
    /from ["']node:https["']/,
    /\bfetch\(/,
  ];

  const files = (await readdir(srcDir)).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "expected at least one src file to check");
  for (const file of files) {
    const contents = await readFile(path.join(srcDir, file), "utf8");
    for (const pattern of bannedPatterns) {
      assert.equal(pattern.test(contents), false, `${file} must not match banned network pattern ${pattern}`);
    }
  }
});
