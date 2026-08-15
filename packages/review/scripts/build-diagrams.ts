#!/usr/bin/env tsx
/**
 * build-diagrams.ts -- the build-time gate for the M5 "code diagrams"
 * mechanism.
 *
 * docs/03-architecture.md: "Code diagrams -- on demand only, explicitly
 * labelled static approximations." This script is the literal build gate
 * proving the milestone's acceptance bar: "A code diagram citing a symbol
 * absent from the AST fails the build."
 *
 * Usage:
 *   tsx scripts/build-diagrams.ts [--dir <diagramsDir>] [--out <outDir>]
 *
 * - Reads every `*.diagram.json` file in `--dir` (default: `diagrams/`
 *   relative to this package), parses it as a `DiagramSpec`.
 * - Validates every spec's cited file+symbols against the REAL parsed AST
 *   via `validateDiagramSpec` (ast-validate.ts).
 * - On success (every spec valid): writes one plain-text `.md` rendering
 *   per diagram under `--out`, and exits 0.
 * - On ANY invalid spec (missing symbol, or a cited file that doesn't
 *   exist -- validateDiagramSpec throws for that case): prints a clear
 *   error naming the offending file/symbol, writes NO output files at all
 *   (fail closed -- a bad diagram must never silently produce a rendered
 *   artifact next to good ones), and exits with a non-zero code.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDiagramSpec, type DiagramSpec } from "../src/ast-validate.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** packages/review/scripts -> packages/review -> packages -> repo root. */
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

function parseArgs(argv: string[]): { dir: string; out: string } {
  let dir = path.join(SCRIPT_DIR, "..", "diagrams");
  let out = path.join(SCRIPT_DIR, "..", "diagrams-out");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = path.resolve(argv[i + 1]!);
      i++;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = path.resolve(argv[i + 1]!);
      i++;
    }
  }
  return { dir, out };
}

function renderMarkdown(spec: DiagramSpec): string {
  return [
    `# ${spec.title}`,
    "",
    "**Static approximation -- generated on demand, not kept in sync automatically.**",
    "",
    spec.description,
    "",
    `Source: \`${spec.file}\``,
    "",
    "Cited symbols:",
    ...spec.symbols.map((s) => `- \`${s}\``),
    "",
  ].join("\n");
}

function main(): void {
  const { dir, out } = parseArgs(process.argv.slice(2));

  if (!existsSync(dir)) {
    console.error(`build-diagrams: diagrams directory does not exist: ${dir}`);
    process.exit(1);
  }

  const specFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".diagram.json"))
    .sort();

  if (specFiles.length === 0) {
    console.error(`build-diagrams: no *.diagram.json files found in ${dir}`);
    process.exit(1);
  }

  const errors: string[] = [];
  const rendered: Array<{ outName: string; content: string }> = [];

  for (const specFile of specFiles) {
    const fullSpecPath = path.join(dir, specFile);
    let spec: DiagramSpec;
    try {
      spec = JSON.parse(readFileSync(fullSpecPath, "utf8")) as DiagramSpec;
    } catch (err) {
      errors.push(`${specFile}: could not parse as JSON -- ${(err as Error).message}`);
      continue;
    }

    try {
      const result = validateDiagramSpec(REPO_ROOT, spec);
      if (!result.valid) {
        errors.push(
          `${specFile}: cites symbol(s) absent from the AST of ${result.file}: ${result.missingSymbols.join(", ")}`,
        );
        continue;
      }
      rendered.push({ outName: specFile.replace(/\.diagram\.json$/, ".md"), content: renderMarkdown(spec) });
    } catch (err) {
      // validateDiagramSpec throws when the cited file itself doesn't
      // exist on disk -- same class of failure as a missing symbol.
      errors.push(`${specFile}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    console.error("build-diagrams: FAILED -- the following diagram spec(s) are invalid:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("build-diagrams: writing NO output files (fail closed).");
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  for (const { outName, content } of rendered) {
    writeFileSync(path.join(out, outName), content, "utf8");
  }
  console.log(`build-diagrams: OK -- rendered ${rendered.length} diagram(s) to ${out}`);
  process.exit(0);
}

main();
