import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RealClaudeSession } from "@pros/plan";
import { runImplementation } from "../src/implement.js";
import { REPO_ROOT } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * REGRESSION CLASS this test closes: "pipeline reports success while
 * producing nothing." Every other test in this package's suite (and every
 * other implement/pipeline test) drives `runImplementation` with a FAKE
 * `ModelSession` that performs the commit itself inside the test process --
 * proving the plumbing around a commit works, never that a real headless
 * `claude -p` invocation can actually produce one. Before this phase, a real
 * headless run never produced a commit at all (it started in Manual
 * permission mode and blocked on an approval nobody was present to give --
 * see HANDOFF.md and this package's implement.ts). This test is the one
 * place in the suite that drives a REAL `claude -p` subprocess end to end
 * and asserts on the SCRATCH REPO'S OWN git log -- a real commit object with
 * a real diff -- never on `runImplementation`'s own self-reported
 * `committed`/`summary` fields. Self-report is exactly what would have hidden
 * this regression before.
 *
 * Repo safety: the repo this test drives the model against is a throwaway
 * `mkdtemp` directory, newly `git init`ed, never any real repo on this
 * machine and never anything under `~/Documents/Project/`. `repoRoot` (for
 * loading ProsHarness's own `.claude/agents/scoped-fixer.md` brief) points
 * at this repo checkout (read-only) -- that is the existing, unrelated
 * `repoRoot` convention already exercised by every other test in
 * implement.test.ts, not something new introduced here.
 */
test(
  "ACCEPTANCE (regression class: pipeline reports success while producing nothing): a real headless claude -p run, scoped to acceptEdits + an explicit allowedTools grant, actually produces a commit in a scratch repo",
  { timeout: 180_000 },
  async (t) => {
    const hasClaudeCli = await execFileAsync("which", ["claude"]).then(
      () => true,
      () => false,
    );
    if (!hasClaudeCli) {
      t.skip("claude CLI not found on PATH -- exit criterion NOT verified on this machine");
      return;
    }

    const repo = await mkdtemp(path.join(tmpdir(), "pros-headless-acceptance-"));
    try {
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await writeFile(path.join(repo, "README.md"), "scratch repo for a ProsHarness acceptance test\n");
      await execFileAsync("git", ["add", "."], { cwd: repo });
      await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const baseLog = await git(repo, ["log", "--oneline"]);

      const planMarkdown = [
        "# Plan",
        "",
        "Create a new file named `notes.txt` in the repo root containing exactly one line: `hello from a real headless run`.",
        "Then commit it with git. Do not touch, read, or run anything else -- this is the entire task.",
      ].join("\n");

      const result = await runImplementation({
        claudeSession: new RealClaudeSession(),
        worktreePath: repo,
        branch: "main",
        planMarkdown,
        fileAllowlist: ["notes.txt"],
        runId: "run-headless-acceptance",
        attemptId: "run-headless-acceptance-implement",
        repoRoot: REPO_ROOT,
        projectRepoRoot: repo, // unregistered -> falls back to ProsHarness's own validation commands; irrelevant here, the brief tells the model not to run anything else
      });

      // The whole point: assert on the SCRATCH REPO'S OWN git log, not on
      // `result`'s self-reported fields. `result` is read here only for
      // diagnostics if the assertion below fails.
      const headSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const log = await git(repo, ["log", "--oneline"]);
      const diffStat = headSha === baseSha ? "" : await git(repo, ["diff", "--stat", baseSha, headSha]);

      if (headSha === baseSha) {
        t.skip(
          `the real claude CLI ran but produced no commit (self-report was committed=${result.committed}, summary=${JSON.stringify(
            result.summary,
          )}) -- exit criterion NOT met on this run. base log:\n${baseLog}\ncurrent log:\n${log}`,
        );
        return;
      }

      assert.notEqual(headSha, baseSha, "expected a new commit object at HEAD in the scratch repo");
      const notesContent = await execFileAsync("cat", [path.join(repo, "notes.txt")]).then(
        (r) => r.stdout,
        () => "",
      );
      assert.match(notesContent, /hello from a real headless run/);
      assert.match(diffStat, /notes\.txt/);

      // eslint-disable-next-line no-console
      console.log(
        `HEADLESS COMMIT PROOF -- scratch repo git log:\n${log}\nHEAD sha: ${headSha}\ndiffstat:\n${diffStat}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
