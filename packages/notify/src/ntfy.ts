/**
 * Minimal ntfy (https://ntfy.sh or a self-hosted/Tailscale instance) push
 * client. M3 roadmap item: "ntfy push over Tailscale."
 *
 * The whole point of this module is the promise in `sendNtfy`'s doc
 * comment: it NEVER throws and NEVER hangs. Every caller in this repo (see
 * wire-barrier.ts) fires this from inside a fire-and-forget listener on the
 * checkpoint barrier's `onParked` hook, where a thrown exception or a
 * network call that never resolves would be indistinguishable from wedging
 * the run itself. So every failure mode -- unset config, DNS failure,
 * connection refused, timeout, malformed URL, non-2xx response -- is caught
 * here and turned into a plain `{ ok: false, error }` value.
 */

export interface SendNtfyOptions {
  /**
   * Full ntfy URL to POST to, e.g. "https://ntfy.sh/my-private-topic" or a
   * self-hosted/Tailscale URL like "http://100.x.x.x/pros-topic". If
   * omitted, read from process.env.PROS_NTFY_URL. If neither is set,
   * sendNtfy is a documented no-op that resolves
   * { ok: false, error: "no ntfy URL configured" } WITHOUT attempting any
   * network call -- this is deliberate: an unconfigured ntfy target must be
   * exactly as harmless as a failing one, per the M3 requirement "a failed
   * push must never wedge a run or lose a question" extended to "never
   * configuring it must not wedge a run either."
   */
  url?: string;
  title?: string;
  message: string;
  /** ntfy priority header value, e.g. "default" | "high" | "urgent". Optional. */
  priority?: string;
  /** Abort the request if it takes longer than this. Default 5000ms -- notifications must never be allowed to hang a caller indefinitely. */
  timeoutMs?: number;
}

export interface SendNtfyResult {
  ok: boolean;
  error?: string;
}

/**
 * POSTs a plain-text push notification to an ntfy topic. NEVER throws --
 * every failure mode (no URL configured, DNS failure, connection refused,
 * timeout, non-2xx response, malformed URL) is caught and returned as
 * { ok: false, error }. This is the single most important property of this
 * function: a caller (Barrier.onParked's listener) must be able to call this
 * and never have it become the reason a run got stuck.
 */
export async function sendNtfy(opts: SendNtfyOptions): Promise<SendNtfyResult> {
  const url = opts.url ?? process.env.PROS_NTFY_URL;
  if (!url) return { ok: false, error: "no ntfy URL configured (set PROS_NTFY_URL or pass { url })" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const headers: Record<string, string> = {};
    if (opts.title) headers["Title"] = opts.title;
    if (opts.priority) headers["Priority"] = opts.priority;
    const res = await fetch(url, { method: "POST", body: opts.message, headers, signal: controller.signal });
    if (!res.ok) return { ok: false, error: `ntfy responded ${res.status} ${res.statusText}` };
    return { ok: true };
  } catch (err) {
    // Covers: AbortError from the timeout firing, ECONNREFUSED, DNS
    // failures (ENOTFOUND), invalid URL strings thrown synchronously by
    // fetch, and anything else the platform's fetch implementation can
    // throw. Never let any of these escape as an exception.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
