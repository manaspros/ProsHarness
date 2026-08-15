import { sendNtfy } from "./ntfy.js";

/**
 * Mirrors the info payload `Barrier.onParked` fires with (see
 * packages/barrier/src/barrier.ts's `ParkedListener` type). Duplicated here
 * rather than imported so that @pros/notify has ZERO dependency on
 * @pros/barrier -- it stays a leaf package, trivially unit-testable against
 * a structural fake, and never needs to be rebuilt in lockstep with barrier
 * internals.
 */
export interface ParkedNotificationInfo {
  runId: string;
  checkpointId: string;
  questionId: string;
  gateType: "ask_human" | "plan_approval";
  prompt: string;
  planRef?: { planId: string; version: number };
}

/**
 * Structural type matching Barrier.onParked's signature -- avoids an
 * @pros/barrier dependency entirely. Any object with an `onParked` method
 * shaped like this (the real Barrier, a test fake, a future alternative
 * implementation) can be wired up.
 */
export interface ParkedNotifierSource {
  onParked(cb: (info: ParkedNotificationInfo) => void): () => void;
}

export interface WireNtfyOptions {
  url?: string;
  /** Called with each sendNtfy result, for logging/testing -- optional, never required. */
  onResult?: (info: ParkedNotificationInfo, result: { ok: boolean; error?: string }) => void;
}

/**
 * Subscribes to a Barrier-like source's onParked hook and fires an ntfy push
 * for every parked checkpoint (both ask_human "Questions" and submit_plan
 * "Gate 1 plan approval" parks get a human-readable notification). Returns
 * an unsubscribe function, mirroring onParked's own contract.
 *
 * Critical property, proven by the tests in test/wire-barrier.test.ts: no
 * matter what sendNtfy does (succeeds, fails, times out), it NEVER becomes
 * something the caller of onParked's underlying park sequence has to wait
 * on or handle. This function's callback body dispatches an async
 * operation it does NOT await into the park sequence -- Barrier.onParked
 * already fires listeners via a microtask + try/catch, so this function
 * does not need to duplicate that defense, but it must still never let a
 * rejected promise become unhandled (hence the unconditional `.catch`
 * below, belt-and-braces on top of sendNtfy's own promise-that-never-
 * rejects contract).
 */
export function wireNtfyNotifications(source: ParkedNotifierSource, opts: WireNtfyOptions = {}): () => void {
  return source.onParked((info) => {
    const message = buildMessage(info);
    sendNtfy({ url: opts.url, title: gateTitle(info), message })
      .then((result) => opts.onResult?.(info, result))
      .catch(() => undefined); // belt-and-braces -- sendNtfy itself never throws, but never trust that from the calling side either
  });
}

function gateTitle(info: ParkedNotificationInfo): string {
  return info.gateType === "plan_approval"
    ? "ProsHarness: plan awaiting Gate 1 approval"
    : "ProsHarness: question awaiting your answer";
}

const MAX_PROMPT_LEN = 200;

/**
 * Human-readable one-liner for a phone lock screen: run id, and either the
 * plan ref (plan_approval) or the truncated question prompt (ask_human).
 */
function buildMessage(info: ParkedNotificationInfo): string {
  const shortRun = info.runId.slice(0, 12);
  if (info.gateType === "plan_approval" && info.planRef) {
    return `Run ${shortRun}: plan ${info.planRef.planId} v${info.planRef.version} is awaiting Gate 1 approval.`;
  }
  const prompt =
    info.prompt.length > MAX_PROMPT_LEN ? info.prompt.slice(0, MAX_PROMPT_LEN) + "…" : info.prompt;
  return `Run ${shortRun}: ${prompt}`;
}
