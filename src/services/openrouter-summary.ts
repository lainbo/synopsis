import { getApiBaseUrl, getRequiredEnv } from "./config";
import { buildSummaryPrompt } from "./summary-prompt";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import { parseChatCompletionResponse, parseRetryAfterMs } from "./chat-completions";
import type { Env } from "../types";

const OPENROUTER_TIMEOUT_MS = 12000;
const OPENROUTER_SUMMARY_MAX_ATTEMPTS = 3;

export class OpenRouterSummaryError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(reason: string, status?: number) {
    super("OpenRouter summary failed");
    this.name = "OpenRouterSummaryError";
    this.reason = reason;
    this.status = status;
  }
}

interface OpenRouterRequestBody {
  model: string;
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature: number;
  provider: { zdr: boolean };
  reasoning?: {
    effort?: string;
    exclude?: boolean;
  };
}

type RequestSummaryResult =
  | { ok: true; summary: string; model: string }
  | {
      ok: false;
      reason: string;
      detail?: string;
      model?: string;
      retryAfterMs?: number;
    };

type ModelSummaryResult = RequestSummaryResult & {
  privacyDowngraded: boolean;
};

interface RequestSummaryOptions {
  stopAfterFirstFallbackableFailure?: boolean;
}

export async function generateOpenRouterSummary(
  env: Env,
  mail: SummaryMailInput
): Promise<SummaryResult> {
  let prompt: string;
  let zdrEnabled: boolean;
  let primaryModel: string;
  let fallbackModel: string | undefined;

  try {
    prompt = buildSummaryPrompt(env, { to: mail.to, text: mail.text || "" });
    zdrEnabled = isZdrEnabled(env);
    primaryModel = getRequiredEnv(env, "OPENROUTER_MODEL");
    fallbackModel = getOptionalFallbackModel(env, primaryModel);
    getRequiredEnv(env, "OPENROUTER_API_KEY");
    getApiBaseUrl(env.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
  } catch {
    return {
      ok: false,
      reason: "openrouter_config_invalid",
      privacyDowngraded: false,
      fallbackModelUsed: false
    };
  }

  const primary = await requestSummaryForModel(env, prompt, primaryModel, zdrEnabled, {
    stopAfterFirstFallbackableFailure: Boolean(fallbackModel)
  });

  if (primary.ok) {
    return {
      ok: true,
      summary: primary.summary,
      privacyDowngraded: primary.privacyDowngraded,
      fallbackModelUsed: false,
      model: primary.model
    };
  }

  if (fallbackModel && shouldSwitchToFallbackModel(primary.reason)) {
    const fallback = await requestSummaryForModel(env, prompt, fallbackModel, zdrEnabled);

    if (fallback.ok) {
      return {
        ok: true,
        summary: fallback.summary,
        privacyDowngraded: fallback.privacyDowngraded,
        fallbackModelUsed: true,
        model: fallback.model
      };
    }

    return {
      ok: false,
      reason: fallback.reason,
      detail: fallback.detail,
      privacyDowngraded: fallback.privacyDowngraded,
      fallbackModelUsed: false,
      model: fallback.model
    };
  }

  return {
    ok: false,
    reason: primary.reason,
    detail: primary.detail,
    privacyDowngraded: primary.privacyDowngraded,
    fallbackModelUsed: false,
    model: primary.model
  };
}

function isZdrEnabled(env: Env): boolean {
  const configured = env.OPENROUTER_ZDR?.trim().toLowerCase();

  return configured === "true" || configured === "1";
}

async function requestSummary(
  env: Env,
  prompt: string,
  model: string,
  zdr: boolean,
  options: RequestSummaryOptions = {}
): Promise<RequestSummaryResult> {
  let last: RequestSummaryResult | undefined;

  for (let attempt = 1; attempt <= OPENROUTER_SUMMARY_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestSummaryOnce(env, prompt, model, zdr);

    if (result.ok) {
      return result;
    }

    last = result;

    if (
      options.stopAfterFirstFallbackableFailure &&
      shouldSwitchToFallbackModel(result.reason)
    ) {
      return result;
    }

    if (!shouldRetrySummaryRequest(result, attempt, zdr)) {
      return result;
    }

    await waitBeforeRetry(result);
  }

  return last ?? { ok: false, reason: "openrouter_fetch_failed" };
}

async function requestSummaryOnce(
  env: Env,
  prompt: string,
  model: string,
  zdr: boolean
): Promise<RequestSummaryResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const body: OpenRouterRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
      provider: { zdr }
    };
    const reasoning = buildReasoningConfig(env);

    if (reasoning) {
      body.reasoning = reasoning;
    }

    const response = await fetch(`${getApiBaseUrl(env.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getRequiredEnv(env, "OPENROUTER_API_KEY")}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));

      const error = await parseErrorReason(response);

      return {
        ok: false,
        reason: error.reason,
        detail: error.detail,
        retryAfterMs
      };
    }

    return await parseChatCompletionResponse(response, model, "openrouter");
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof DOMException && error.name === "AbortError"
        ? "openrouter_timeout"
        : "openrouter_fetch_failed",
      detail: error instanceof Error ? sanitizeOpenRouterErrorDetail(error.message) : undefined
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getOptionalFallbackModel(env: Env, primaryModel: string): string | undefined {
  const configured = env.OPENROUTER_FALLBACK_MODEL?.trim();

  return configured && configured !== primaryModel ? configured : undefined;
}

function buildReasoningConfig(env: Env): OpenRouterRequestBody["reasoning"] | undefined {
  const effort = env.OPENROUTER_REASONING_EFFORT?.trim();

  if (!effort) {
    return undefined;
  }

  const configuredExclude = env.OPENROUTER_REASONING_EXCLUDE?.trim().toLowerCase();
  const exclude = configuredExclude
    ? configuredExclude === "true" || configuredExclude === "1"
    : true;

  return { effort, exclude };
}

function shouldRetrySummaryRequest(
  result: RequestSummaryResult,
  attempt: number,
  zdr: boolean
): boolean {
  if (result.ok || attempt >= OPENROUTER_SUMMARY_MAX_ATTEMPTS) {
    return false;
  }

  if (zdr && shouldDowngradeZdr(result.reason)) {
    return false;
  }

  return isRetryableSummaryReason(result.reason);
}

function isRetryableSummaryReason(reason: string): boolean {
  if (
    reason === "openrouter_timeout" ||
    reason === "openrouter_fetch_failed" ||
    reason === "openrouter_invalid_response" ||
    reason === "openrouter_empty_summary" ||
    reason === "openrouter_output_truncated" ||
    reason === "openrouter_http_403" ||
    reason === "openrouter_http_408" ||
    reason === "openrouter_http_409" ||
    reason === "openrouter_http_425" ||
    reason === "openrouter_http_429"
  ) {
    return true;
  }

  const match = /^openrouter_http_(\d{3})$/.exec(reason);

  if (!match) {
    return false;
  }

  const status = Number(match[1]);

  return status >= 500 && status <= 599;
}

async function requestSummaryForModel(
  env: Env,
  prompt: string,
  model: string,
  zdrEnabled: boolean,
  options: RequestSummaryOptions = {}
): Promise<ModelSummaryResult> {
  const first = await requestSummary(env, prompt, model, zdrEnabled, options);

  if (first.ok) {
    return {
      ...first,
      privacyDowngraded: false
    };
  }

  if (
    options.stopAfterFirstFallbackableFailure &&
    shouldSwitchToFallbackModel(first.reason)
  ) {
    return {
      ...first,
      privacyDowngraded: false
    };
  }

  if (zdrEnabled && shouldDowngradeZdr(first.reason)) {
    const retry = await requestSummary(env, prompt, model, false);

    return {
      ...retry,
      privacyDowngraded: true
    };
  }

  return {
    ...first,
    privacyDowngraded: false
  };
}

function shouldSwitchToFallbackModel(reason: string): boolean {
  return shouldDowngradeZdr(reason) || isRetryableSummaryReason(reason);
}

async function waitBeforeRetry(result: RequestSummaryResult): Promise<void> {
  if (result.ok || !result.retryAfterMs) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
}

async function parseErrorReason(
  response: Response
): Promise<{ reason: string; detail?: string }> {
  let text = "";

  try {
    text = await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { reason: `openrouter_http_${response.status}` };
  }

  const detail = extractOpenRouterErrorDetail(text);
  const lower = text.toLowerCase();

  if (
    lower.includes("zdr") ||
    lower.includes("no endpoint") ||
    lower.includes("no available") ||
    lower.includes("no provider") ||
    (lower.includes("provider") && lower.includes("route"))
  ) {
    return {
      reason: "openrouter_zdr_route_unavailable",
      detail
    };
  }

  return {
    reason: `openrouter_http_${response.status}`,
    detail
  };
}

function shouldDowngradeZdr(reason: string): boolean {
  return reason === "openrouter_zdr_route_unavailable" || reason === "openrouter_http_403";
}

function extractOpenRouterErrorDetail(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(trimmed);
  } catch {
    return sanitizeOpenRouterErrorDetail(trimmed);
  }

  const candidates = collectOpenRouterErrorCandidates(payload);
  const detail = candidates
    .map((candidate) => sanitizeOpenRouterErrorDetail(candidate))
    .find((candidate) => candidate && !isGenericErrorCandidate(candidate));

  return detail ?? candidates.map(sanitizeOpenRouterErrorDetail).find(Boolean);
}

function collectOpenRouterErrorCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates: string[] = [];

  pushString(candidates, record.message);
  pushString(candidates, record.detail);

  const error = record.error;

  if (typeof error === "string") {
    candidates.push(error);
  } else if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    const metadata = errorRecord.metadata;

    if (metadata && typeof metadata === "object") {
      const metadataRecord = metadata as Record<string, unknown>;

      pushProviderDetail(candidates, metadataRecord.provider_name, metadataRecord.raw);
      pushString(candidates, metadataRecord.raw);
      pushString(candidates, metadataRecord.provider_name);
    }

    pushString(candidates, errorRecord.message);
    pushString(candidates, errorRecord.code);
  }

  return candidates;
}

function pushProviderDetail(
  output: string[],
  providerName: unknown,
  raw: unknown
): void {
  if (
    typeof providerName !== "string" ||
    !providerName.trim() ||
    typeof raw !== "string" ||
    !raw.trim()
  ) {
    return;
  }

  output.push(`${providerName.trim()}: ${raw.trim()}`);
}

function pushString(output: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    output.push(value);
  }
}

function isGenericErrorCandidate(value: string): boolean {
  return value === "error" || value === "forbidden" || value === "unauthorized";
}

function sanitizeOpenRouterErrorDetail(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return undefined;
  }

  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized;
}
