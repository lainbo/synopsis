import { getApiBaseUrl, getOpenAIExtraBody, getRequiredEnv } from "./config";
import { parseChatCompletionResponse, parseRetryAfterMs } from "./chat-completions";
import { buildSummaryPrompt } from "./summary-prompt";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import type { Env } from "../types";

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
      ...getOpenAIExtraBody(env),
      model,
      messages: [{ role: "user", content: buildSummaryPrompt(env, { to: mail.to, text: mail.text || "" }) }],
      stream: false
    });
  } catch {
    return { ok: false, reason: "openai_config_invalid", privacyDowngraded: false, fallbackModelUsed: false };
  }

  let last: SummaryResult = failure("openai_fetch_failed", model);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let retryAfterMs = 0;
    let retryable = true;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal
      });
      if (response.ok) {
        const parsed = await parseChatCompletionResponse(response, model, "openai");
        last = { ...parsed, privacyDowngraded: false, fallbackModelUsed: false };
        if (last.ok) return last;
        retryable = last.reason !== "openai_blocked";
      } else {
        // Compatible services may echo input in errors; keep only the HTTP status.
        await response.body?.cancel();
        last = failure(`openai_http_${response.status}`, model);
        retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After")) ?? 0;
      }
    } catch (error) {
      last = failure(error instanceof Error && error.name === "AbortError" ? "openai_timeout" : "openai_fetch_failed", model);
    } finally {
      clearTimeout(timeout);
    }
    if (!retryable || attempt === 3) break;
    if (retryAfterMs) await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  }
  return last;
}

function failure(reason: string, model: string): SummaryResult {
  return { ok: false, reason, model, privacyDowngraded: false, fallbackModelUsed: false };
}
