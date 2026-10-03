import type { SummaryResult } from "./email-summary";

export const SUMMARY_TIMEOUT_MS = 12000;

const SUMMARY_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 2000;
const MAX_ERROR_DETAIL_LENGTH = 240;
const RETRYABLE_FAILURES = new Set([
  "timeout",
  "fetch_failed",
  "invalid_response",
  "empty_summary",
  "output_truncated"
]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const GENERIC_ERROR_DETAILS = new Set(["error", "forbidden", "unauthorized"]);

export type SummaryRequestResult =
  | { ok: true; summary: string; model: string }
  | {
      ok: false;
      reason: string;
      detail?: string;
      model?: string;
      retryAfterMs?: number;
    };

export async function requestSummaryWithRetry(
  requestOnce: () => Promise<SummaryRequestResult>,
  shouldRetry: (reason: string) => boolean
): Promise<SummaryRequestResult> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await requestOnce();

    if (result.ok || attempt >= SUMMARY_MAX_ATTEMPTS || !shouldRetry(result.reason)) {
      return result;
    }

    if (result.retryAfterMs) {
      await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
    }
  }
}

export function isRetryableSummaryReason(provider: string, reason: string): boolean {
  const prefix = `${provider}_`;

  if (!reason.startsWith(prefix)) {
    return false;
  }

  const failure = reason.slice(prefix.length);
  const status = Number(/^http_(\d{3})$/.exec(failure)?.[1]);

  return RETRYABLE_FAILURES.has(failure) || RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

export function toSummaryResult(
  result: SummaryRequestResult,
  flags: { privacyDowngraded: boolean; fallbackModelUsed: boolean }
): SummaryResult {
  if (result.ok) {
    const { summary, model } = result;
    return { ok: true, summary, model, ...flags };
  }

  const { reason, detail, model } = result;
  return { ok: false, reason, detail, model, ...flags };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  // Retry-After 可能是秒数，也可能是 HTTP 日期。
  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();

  return delayMs > 0 ? Math.min(delayMs, MAX_RETRY_AFTER_MS) : undefined;
}

export async function readErrorText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return "";
  }
}

export function extractErrorDetail(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(trimmed);
  } catch {
    return sanitizeErrorDetail(trimmed);
  }

  const details = collectErrorCandidates(payload)
    .map(sanitizeErrorDetail)
    .filter((detail): detail is string => Boolean(detail));

  return details.find((detail) => !GENERIC_ERROR_DETAILS.has(detail)) ?? details[0];
}

export function sanitizeErrorDetail(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z._-]{20,})/g, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return undefined;
  }

  return sanitized.length > MAX_ERROR_DETAIL_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_DETAIL_LENGTH - 3)}...`
    : sanitized;
}

// 兼容 OpenRouter（error.metadata 带上游供应商原始错误）和 Gemini（error.status）两种错误结构。
function collectErrorCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!isRecord(value)) {
    return [];
  }

  const { message, status, detail, error } = value;
  const nested = isRecord(error) ? error : {};
  const { provider_name: providerName, raw } = isRecord(nested.metadata) ? nested.metadata : {};
  const providerRaw = isNonEmptyString(providerName) && isNonEmptyString(raw)
    ? `${providerName.trim()}: ${raw.trim()}`
    : undefined;

  return [
    message,
    status,
    detail,
    error,
    providerRaw,
    raw,
    providerName,
    nested.message,
    nested.status,
    nested.code
  ].filter(isNonEmptyString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
