import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRunOptions, ModelRunResult, ModelSession, ModelUsage } from "../src/model-session.js";

export interface ScriptedResponse {
  text: string;
  usage?: ModelUsage;
  sessionId?: string;
}

export type Script = ScriptedResponse[] | ((opts: ModelRunOptions, callIndex: number) => ScriptedResponse);

const DEFAULT_USAGE: ModelUsage = { inputTokens: 100, outputTokens: 50 };

/**
 * A deterministic, instant-returning fake `ModelSession` for tests -- no
 * subprocess, no network, no API key involved. Responses are scripted
 * either as a fixed array (indexed by call order) or a function of
 * (opts, callIndex), which is what lets a test express "always return a
 * fresh unresolved blocker every round" without needing to know in advance
 * how many rounds will run.
 */
export class ScriptedSession implements ModelSession {
  readonly calls: ModelRunOptions[] = [];
  private callIndex = 0;

  constructor(
    readonly provider: "claude" | "codex",
    private readonly script: Script,
  ) {}

  get callCount(): number {
    return this.calls.length;
  }

  async run(opts: ModelRunOptions): Promise<ModelRunResult> {
    this.calls.push(opts);
    const idx = this.callIndex++;
    const resp =
      typeof this.script === "function"
        ? this.script(opts, idx)
        : this.script[Math.min(idx, this.script.length - 1)];
    if (!resp) throw new Error(`ScriptedSession(${this.provider}): no scripted response for call index ${idx}`);
    return { text: resp.text, usage: resp.usage ?? DEFAULT_USAGE, sessionId: resp.sessionId };
  }
}

export async function makeRunDir(): Promise<{ runsRoot: string; runId: string; runDir: string }> {
  const runsRoot = await mkdtemp(path.join(tmpdir(), "pros-plan-runs-"));
  const runId = "run-test-1";
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  return { runsRoot, runId, runDir };
}
