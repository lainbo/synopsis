import { getApiBaseUrl, getRequiredEnv } from "./config";
import { buildSummaryPrompt } from "./summary-prompt";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import type { Env } from "../types";

const GEMINI_TIMEOUT_MS = 12000;
const GEMINI_SUMMARY_MAX_ATTEMPTS = 3;
const GEMINI_MAX_RETRY_AFTER_MS = 2000;
const GEMINI_MAX_OUTPUT_TOKENS = 2048;

const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII"
]);

interface GeminiRequestBody {
  contents: Array<{
    role: "user";
    parts: Array<{ text: string }>;
  }>;
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: {
      thinkingLevel?: "low";
      thinkingBudget?: number;
    };
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

export async function generateGeminiSummary(
  env: Env,
  mail: SummaryMailInput
): Promise<SummaryResult> {
  let prompt: string;
  let model: string;

  try {
    prompt = buildSummaryPrompt(env, { to: mail.to, text: mail.text || "" });
    model = normalizeGeminiModelId(getRequiredEnv(env, "GEMINI_MODEL"));
    getRequiredEnv(env, "GEMINI_API_KEY");
    getApiBaseUrl(env.GEMINI_BASE_URL, "https://generativelanguage.googleapis.com/v1beta");
  } catch {
    return {
      ok: false,
      reason: "gemini_config_invalid",
      privacyDowngraded: false,
      fallbackModelUsed: false
    };
  }

  const result = await requestSummary(env, prompt, model);

  if (result.ok) {
    return {
      ok: true,
      summary: result.summary,
      privacyDowngraded: false,
      fallbackModelUsed: false,
      model: result.model
    };
  }

  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    privacyDowngraded: false,
    fallbackModelUsed: false,
    model: result.model
  };
}

async function requestSummary(
  env: Env,
  prompt: string,
  model: string
): Promise<RequestSummaryResult> {
  let last: RequestSummaryResult | undefined;

  for (let attempt = 1; attempt <= GEMINI_SUMMARY_MAX_ATTEMPTS; attempt += 1) {
    const result = await requestSummaryOnce(env, prompt, model);

    if (result.ok) {
      return result;
    }

    last = result;

    if (!shouldRetrySummaryRequest(result, attempt)) {
      return result;
    }

    await waitBeforeRetry(result);
  }

  return last ?? { ok: false, reason: "gemini_fetch_failed" };
}

async function requestSummaryOnce(
  env: Env,
  prompt: string,
  model: string
): Promise<RequestSummaryResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const body: GeminiRequestBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
      }
    };
    const thinkingConfig = buildThinkingConfig(model);

    if (thinkingConfig) {
      body.generationConfig.thinkingConfig = thinkingConfig;
    }

    const response = await fetch(buildGenerateContentUrl(env, model), {
      method: "POST",
      headers: {
        "x-goog-api-key": getRequiredEnv(env, "GEMINI_API_KEY"),
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = await parseErrorReason(response);

      return {
        ok: false,
        reason: error.reason,
        detail: error.detail,
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After"))
      };
    }

    return await parseSummaryResponse(response, model);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DOMException && error.name === "AbortError"
          ? "gemini_timeout"
          : "gemini_fetch_failed",
      detail: error instanceof Error ? sanitizeGeminiErrorDetail(error.message) : undefined
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeGeminiModelId(model: string): string {
  return model.replace(/^models\//i, "");
}

function buildGenerateContentUrl(env: Env, model: string): string {
  return `${getApiBaseUrl(env.GEMINI_BASE_URL, "https://generativelanguage.googleapis.com/v1beta")}/models/${encodeURIComponent(model)}:generateContent`;
}

function buildThinkingConfig(
  model: string
): GeminiRequestBody["generationConfig"]["thinkingConfig"] {
  const id = model.toLowerCase();

  if (id.startsWith("gemini-3")) {
    return { thinkingLevel: "low" };
  }

  if (id.startsWith("gemini-2.5")) {
    return { thinkingBudget: 0 };
  }

  return undefined;
}

function shouldRetrySummaryRequest(result: RequestSummaryResult, attempt: number): boolean {
  if (result.ok || attempt >= GEMINI_SUMMARY_MAX_ATTEMPTS) {
    return false;
  }

  return isRetryableSummaryReason(result.reason);
}

function isRetryableSummaryReason(reason: string): boolean {
  if (
    reason === "gemini_timeout" ||
    reason === "gemini_fetch_failed" ||
    reason === "gemini_invalid_response" ||
    reason === "gemini_empty_summary" ||
    reason === "gemini_output_truncated" ||
    reason === "gemini_http_408" ||
    reason === "gemini_http_409" ||
    reason === "gemini_http_425" ||
    reason === "gemini_http_429"
  ) {
    return true;
  }

  const match = /^gemini_http_(\d{3})$/.exec(reason);

  if (!match) {
    return false;
  }

  const status = Number(match[1]);

  return status >= 500 && status <= 599;
}

async function waitBeforeRetry(result: RequestSummaryResult): Promise<void> {
  if (result.ok || !result.retryAfterMs) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, GEMINI_MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(value);

  if (!Number.isFinite(dateMs)) {
    return undefined;
  }

  const delayMs = dateMs - Date.now();

  if (delayMs <= 0) {
    return undefined;
  }

  return Math.min(delayMs, GEMINI_MAX_RETRY_AFTER_MS);
}

async function parseSummaryResponse(
  response: Response,
  defaultModel: string
): Promise<RequestSummaryResult> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { ok: false, reason: "gemini_invalid_response" };
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "gemini_invalid_response" };
  }

  const record = payload as Record<string, unknown>;
  const model = parseResponseModel(record, defaultModel);
  const candidates = record.candidates;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (hasBlockedPrompt(record)) {
      return { ok: false, reason: "gemini_blocked", model };
    }

    return { ok: false, reason: "gemini_invalid_response", model };
  }

  const first = candidates[0];

  if (!first || typeof first !== "object") {
    return { ok: false, reason: "gemini_invalid_response", model };
  }

  const candidate = first as Record<string, unknown>;
  const finishReason = parseFinishReason(candidate.finishReason);

  if (finishReason === "MAX_TOKENS") {
    return { ok: false, reason: "gemini_output_truncated", model };
  }

  if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) {
    return { ok: false, reason: "gemini_blocked", model };
  }

  const summary = extractSummaryText(candidate);

  if (!summary) {
    return { ok: false, reason: "gemini_empty_summary", model };
  }

  return { ok: true, summary, model };
}

function parseResponseModel(payload: Record<string, unknown>, defaultModel: string): string {
  const modelVersion = payload.modelVersion;

  return typeof modelVersion === "string" && modelVersion.trim()
    ? modelVersion.trim()
    : defaultModel;
}

function parseFinishReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasBlockedPrompt(payload: Record<string, unknown>): boolean {
  const promptFeedback = payload.promptFeedback;

  if (!promptFeedback || typeof promptFeedback !== "object") {
    return false;
  }

  const blockReason = (promptFeedback as Record<string, unknown>).blockReason;

  return typeof blockReason === "string" && blockReason.trim() !== "";
}

function extractSummaryText(candidate: Record<string, unknown>): string {
  const content = candidate.content;

  if (!content || typeof content !== "object") {
    return "";
  }

  const parts = (content as Record<string, unknown>).parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  const texts: string[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const record = part as Record<string, unknown>;

    if (record.thought === true) {
      continue;
    }

    if (typeof record.text === "string" && record.text.trim()) {
      texts.push(record.text.trim());
    }
  }

  return texts.join("\n").trim();
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
    return { reason: `gemini_http_${response.status}` };
  }

  return {
    reason: `gemini_http_${response.status}`,
    detail: extractGeminiErrorDetail(text)
  };
}

function extractGeminiErrorDetail(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(trimmed);
  } catch {
    return sanitizeGeminiErrorDetail(trimmed);
  }

  const candidates = collectGeminiErrorCandidates(payload);
  const detail = candidates
    .map((candidate) => sanitizeGeminiErrorDetail(candidate))
    .find((candidate) => candidate && !isGenericErrorCandidate(candidate));

  return detail ?? candidates.map(sanitizeGeminiErrorDetail).find(Boolean);
}

function collectGeminiErrorCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates: string[] = [];

  pushString(candidates, record.message);
  pushString(candidates, record.status);
  pushString(candidates, record.detail);

  const error = record.error;

  if (typeof error === "string") {
    candidates.push(error);
  } else if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;

    pushString(candidates, errorRecord.message);
    pushString(candidates, errorRecord.status);
    pushString(candidates, errorRecord.code);
  }

  return candidates;
}

function pushString(output: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    output.push(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    output.push(String(value));
  }
}

function isGenericErrorCandidate(value: string): boolean {
  return value === "error" || value === "forbidden" || value === "unauthorized";
}

function sanitizeGeminiErrorDetail(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return undefined;
  }

  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized;
}
