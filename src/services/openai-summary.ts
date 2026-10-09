import { getApiBaseUrl, getOpenAIExtraBody, getRequiredEnv } from "./config";
import { parseChatCompletionResponse } from "./chat-completions";
import { buildSummaryPrompt } from "./summary-prompt";
import {
  isAbortError,
  isRetryableSummaryReason,
  parseRetryAfterMs,
  requestSummaryWithRetry,
  SUMMARY_TIMEOUT_MS,
  toSummaryResult,
  type SummaryRequestResult
} from "./summary-request";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import type { Env } from "../types";

const SUMMARY_FLAGS = { privacyDowngraded: false, fallbackModelUsed: false };

export async function generateOpenAISummary(
  env: Env,
  mail: SummaryMailInput
): Promise<SummaryResult> {
  let model: string;
  let apiKey: string;
  let url: string;
  let body: string;

  try {
    model = getRequiredEnv(env, "OPENAI_MODEL");
    apiKey = getRequiredEnv(env, "OPENAI_API_KEY");
    url = `${getApiBaseUrl(env.OPENAI_BASE_URL, "https://api.openai.com/v1")}/chat/completions`;
    body = JSON.stringify({
      reasoning_effort: "low",
      ...getOpenAIExtraBody(env),
      model,
      messages: [{ role: "user", content: buildSummaryPrompt(env, { to: mail.to, text: mail.text || "" }) }],
      stream: false
    });
  } catch {
    return { ok: false, reason: "openai_config_invalid", ...SUMMARY_FLAGS };
  }

  const result = await requestSummaryWithRetry(
    () => requestSummaryOnce(url, apiKey, body, model),
    (reason) => isRetryableSummaryReason("openai", reason)
  );

  return toSummaryResult(result, SUMMARY_FLAGS);
}

async function requestSummaryOnce(
  url: string,
  apiKey: string,
  body: string,
  model: string
): Promise<SummaryRequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
      signal: controller.signal
    });

    if (response.ok) {
      return await parseChatCompletionResponse(response, model, "openai");
    }

    // Compatible services may echo input in errors; keep only the HTTP status.
    await response.body?.cancel();
    return {
      ok: false,
      reason: `openai_http_${response.status}`,
      model,
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After"))
    };
  } catch (error) {
    return {
      ok: false,
      reason: isAbortError(error) ? "openai_timeout" : "openai_fetch_failed",
      model
    };
  } finally {
    clearTimeout(timeout);
  }
}
