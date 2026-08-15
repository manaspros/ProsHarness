import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateDiagramSpec } from "../src/ast-validate.js";
import { REPO_ROOT, PACKAGE_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("validateDiagramSpec: a real file citing a real exported symbol validates clean", () => {
  const result = validateDiagramSpec(REPO_ROOT, {
    file: "packages/review/src/hunks.ts",
    symbols: ["rankHunks", "Hunk"],
    title: "t",
    description: "d",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingSymbols, []);
});

test("validateDiagramSpec: NEGATIVE PROOF -- citing a bogus symbol name in a real file is invalid, and named in missingSymbols", () => {
  const result = validateDiagramSpec(REPO_ROOT, {
    file: "packages/review/src/hunks.ts",
    symbols: ["rankHunks", "totallyBogusSymbolThatDoesNotExist"],
    title: "t",
    description: "d",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingSymbols, ["totallyBogusSymbolThatDoesNotExist"]);
});

test("validateDiagramSpec: throws when the cited file itself does not exist on disk", () => {
  assert.throws(() =>
    validateDiagramSpec(REPO_ROOT, {
      file: "packages/review/src/does-not-exist.ts",
      symbols: ["anything"],
      title: "t",
      description: "d",
    }),
  );
});

test("BUILD-GATE PROOF: build-diagrams.ts as a real subprocess -- good fixtures exit 0 and write output; bad fixtures exit non-zero and write nothing", async () => {
  const goodDir = path.join(PACKAGE_ROOT, "test", "fixtures", "diagrams-good");
  const badDir = path.join(PACKAGE_ROOT, "test", "fixtures", "diagrams-bad");
  const outGood = await mkdtemp(path.join(tmpdir(), "pros-review-diagrams-out-good-"));
  const outBad = await mkdtemp(path.join(tmpdir(), "pros-review-diagrams-out-bad-"));

  try {
    const goodResult = await execFileAsync(
      "npx",
      ["tsx", "scripts/build-diagrams.ts", "--dir", goodDir, "--out", outGood],
      { cwd: PACKAGE_ROOT },
    );
    assert.match(goodResult.stdout, /OK -- rendered/);
    const goodFiles = await readdir(outGood);
    assert.ok(goodFiles.length > 0, "expected rendered output files for the good fixtures");

    let badExitCode: number | null = null;
    let badStderr = "";
    try {
      await execFileAsync("npx", ["tsx", "scripts/build-diagrams.ts", "--dir", badDir, "--out", outBad], {
        cwd: PACKAGE_ROOT,
      });
      assert.fail("expected build-diagrams.ts to exit non-zero for the bad fixtures dir");
    } catch (err: any) {
      badExitCode = err.code ?? null;
      badStderr = err.stderr ?? "";
    }
    assert.notEqual(badExitCode, 0, "expected a non-zero exit code for the bad fixtures dir");
    assert.match(badStderr, /totallyBogusSymbolThatDoesNotExist|absent from the AST/);

    const badFiles = await readdir(outBad);
    assert.deepEqual(badFiles, [], "no output files should be written for a run with an invalid diagram spec");
  } finally {
    await rm(outGood, { recursive: true, force: true });
    await rm(outBad, { recursive: true, force: true });
  }
});
