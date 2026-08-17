/** Runtime response contracts for the /new client actions.
 *
 * These endpoints are intentionally asynchronous and return JSON before the
 * model work finishes. Keep the redirect boundary defensive: a malformed or
 * unexpected 2xx body must never turn into /runs/undefined.
 */

export interface ScannedSignal {
  sourceId: string;
  externalId: string;
  kind: string;
  title: string;
  body: string;
  url?: string;
  evidence?: { file: string; line: number };
}

export interface LaunchSuccessResponse {
  ok: true;
  runId: string;
}

export interface LaunchFailureResponse {
  ok: false;
  message: string;
}

export type LaunchResponse = LaunchSuccessResponse | LaunchFailureResponse;

export interface ScanSuccessResponse {
  ok: true;
  signals: ScannedSignal[];
}

export interface ScanFailureResponse {
  ok: false;
  message: string;
}

export type ScanResponse = ScanSuccessResponse | ScanFailureResponse;

export function parseLaunchResponse(value: unknown): LaunchResponse {
  if (isRecord(value) && value.ok === true && typeof value.runId === "string" && value.runId.trim().length > 0) {
    return { ok: true, runId: value.runId.trim() };
  }
  if (isRecord(value) && value.ok === false && typeof value.message === "string" && value.message.trim().length > 0) {
    return { ok: false, message: value.message.trim() };
  }
  throw new Error("launch returned an invalid response");
}

export function parseScanResponse(value: unknown): ScanResponse {
  if (isRecord(value) && value.ok === true && Array.isArray(value.signals) && value.signals.every(isScannedSignal)) {
    return { ok: true, signals: value.signals };
  }
  if (isRecord(value) && value.ok === false && typeof value.message === "string" && value.message.trim().length > 0) {
    return { ok: false, message: value.message.trim() };
  }
  throw new Error("scan returned an invalid response");
}

export function responseError(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string" && value.error.trim().length > 0 ? value.error : fallback;
}

function isScannedSignal(value: unknown): value is ScannedSignal {
  if (!isRecord(value)) return false;
  if (typeof value.sourceId !== "string" || typeof value.externalId !== "string") return false;
  if (typeof value.kind !== "string" || typeof value.title !== "string" || typeof value.body !== "string") return false;
  if (value.url !== undefined && typeof value.url !== "string") return false;
  if (value.evidence !== undefined) {
    if (
      !isRecord(value.evidence) ||
      typeof value.evidence.file !== "string" ||
      value.evidence.file.trim().length === 0 ||
      typeof value.evidence.line !== "number" ||
      !Number.isInteger(value.evidence.line) ||
      value.evidence.line < 1
    ) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
