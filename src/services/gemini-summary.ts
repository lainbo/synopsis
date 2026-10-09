import { getApiBaseUrl, getRequiredEnv } from "./config";
import { buildSummaryPrompt } from "./summary-prompt";
import {
  extractErrorDetail,
  isAbortError,
  isRetryableSummaryReason,
  parseRetryAfterMs,
  readErrorText,
  requestSummaryWithRetry,
  sanitizeErrorDetail,
  SUMMARY_TIMEOUT_MS,
  toSummaryResult,
  type SummaryRequestResult
} from "./summary-request";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import type { Env } from "../types";

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
    thinkingConfig: { thinkingLevel: "low" };
  };
}

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

  const result = await requestSummaryWithRetry(
    () => requestSummaryOnce(env, prompt, model),
    (reason) => isRetryableSummaryReason("gemini", reason)
  );

  return toSummaryResult(result, { privacyDowngraded: false, fallbackModelUsed: false });
}

async function requestSummaryOnce(
  env: Env,
  prompt: string,
  model: string
): Promise<SummaryRequestResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const body: GeminiRequestBody = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: "low" }
      }
    };

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
      return {
        ok: false,
        reason: `gemini_http_${response.status}`,
        detail: extractErrorDetail(await readErrorText(response)),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After"))
      };
    }

    return await parseSummaryResponse(response, model);
  } catch (error) {
    return {
      ok: false,
      reason: isAbortError(error) ? "gemini_timeout" : "gemini_fetch_failed",
      detail: error instanceof Error ? sanitizeErrorDetail(error.message) : undefined
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

async function parseSummaryResponse(
  response: Response,
  defaultModel: string
): Promise<SummaryRequestResult> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
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
