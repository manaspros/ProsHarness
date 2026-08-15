// One-off fixture capture script — NOT part of the normal test run (no
// *.test.ts suffix, not matched by `node --import tsx --test test/*.test.ts`).
//
// Invokes the real `claude` and `codex` CLIs directly (subscription auth,
// verified no ANTHROPIC_API_KEY/OPENAI_API_KEY set) with a couple of cheap,
// short prompts and writes the raw NDJSON stdout verbatim to
// test/fixtures/{claude,codex}/*.ndjson. Re-run manually (`npx tsx
// packages/adapters/test/capture-fixtures.ts`) only if fixtures need to be
// refreshed against a newer CLI version — this costs real subscription
// quota/time, so don't run it casually.
//
// The fixtures currently committed in test/fixtures/ were captured this way
// on 2026-08-15 against claude 2.1.232 / codex-cli 0.147.0 (see
// docs/01-m0-results.md for the pinned-version context). One of the codex
// tool-call fixtures happens to contain an `item.started` event — a type
// NOT in this package's KNOWN_CODEX_TYPES allowlist — which is a nice
// organic exercise of the "unknown types must not be dropped" invariant
// (parse.test.ts asserts it comes back as `unknown_type`, not thrown away).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

function run(command: string, args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  await mkdir(join(FIXTURES_DIR, "claude"), { recursive: true });
  await mkdir(join(FIXTURES_DIR, "codex"), { recursive: true });

  const claudePong = await run(
    "claude",
    ["-p", "--output-format", "stream-json", "--verbose"],
    "Reply with exactly the word PONG and nothing else.",
  );
  await writeFile(join(FIXTURES_DIR, "claude", "claude-pong.ndjson"), claudePong, "utf8");

  const claudeTool = await run(
    "claude",
    ["-p", "--output-format", "stream-json", "--verbose"],
    "Run pwd using your Bash tool and report the exact output.",
  );
  await writeFile(join(FIXTURES_DIR, "claude", "claude-tool-call.ndjson"), claudeTool, "utf8");

  const codexPong = await run("codex", ["exec", "--json", "-"], "Reply with exactly the word PONG and nothing else.");
  await writeFile(join(FIXTURES_DIR, "codex", "codex-pong.ndjson"), codexPong, "utf8");

  const codexTool = await run(
    "codex",
    ["exec", "--json", "-"],
    "Run pwd using your shell tool and report the exact output.",
  );
  await writeFile(join(FIXTURES_DIR, "codex", "codex-tool-call.ndjson"), codexTool, "utf8");

  console.log("Fixtures captured.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
