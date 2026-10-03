import { getApiBaseUrl, getRequiredEnv } from "./config";
import { buildSummaryPrompt } from "./summary-prompt";
import type { SummaryMailInput, SummaryResult } from "./email-summary";
import { parseChatCompletionResponse } from "./chat-completions";
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
import type { Env } from "../types";

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

type ModelSummaryResult = SummaryRequestResult & {
  privacyDowngraded: boolean;
};

const ZDR_ROUTE_UNAVAILABLE_PATTERN = /zdr|no (?:endpoint|available|provider)/i;

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

  // 配置了备用模型时，主模型只请求一次；遇到可切换错误时，由备用模型负责重试和 ZDR 降级。
  const primary: ModelSummaryResult = fallbackModel
    ? { ...(await requestSummaryOnce(env, prompt, primaryModel, zdrEnabled)), privacyDowngraded: false }
    : await requestSummaryForModel(env, prompt, primaryModel, zdrEnabled);

  if (primary.ok || !fallbackModel || !shouldSwitchToFallbackModel(primary.reason)) {
    return toSummaryResult(primary, {
      privacyDowngraded: primary.privacyDowngraded,
      fallbackModelUsed: false
    });
  }

  const fallback = await requestSummaryForModel(env, prompt, fallbackModel, zdrEnabled);

  return toSummaryResult(fallback, {
    privacyDowngraded: fallback.privacyDowngraded,
    fallbackModelUsed: fallback.ok
  });
}

function isZdrEnabled(env: Env): boolean {
  const configured = env.OPENROUTER_ZDR?.trim().toLowerCase();

  return configured === "true" || configured === "1";
}

async function requestSummaryForModel(
  env: Env,
  prompt: string,
  model: string,
  zdrEnabled: boolean
): Promise<ModelSummaryResult> {
  const first = await requestSummary(env, prompt, model, zdrEnabled);

  if (!first.ok && zdrEnabled && shouldDowngradeZdr(first.reason)) {
    const retry = await requestSummary(env, prompt, model, false);

    return { ...retry, privacyDowngraded: true };
  }

  return { ...first, privacyDowngraded: false };
}

function requestSummary(
  env: Env,
  prompt: string,
  model: string,
  zdr: boolean
): Promise<SummaryRequestResult> {
  return requestSummaryWithRetry(
    () => requestSummaryOnce(env, prompt, model, zdr),
    (reason) => !(zdr && shouldDowngradeZdr(reason)) && isRetryableOpenRouterReason(reason)
  );
}

async function requestSummaryOnce(
  env: Env,
  prompt: string,
  model: string,
  zdr: boolean
): Promise<SummaryRequestResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const reasoning = buildReasoningConfig(env);
    const body: OpenRouterRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
      provider: { zdr },
      ...(reasoning && { reasoning })
    };

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
      return {
        ok: false,
        ...(await parseErrorReason(response)),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After"))
      };
    }

    return await parseChatCompletionResponse(response, model, "openrouter");
  } catch (error) {
    return {
      ok: false,
      reason: isAbortError(error) ? "openrouter_timeout" : "openrouter_fetch_failed",
      detail: error instanceof Error ? sanitizeErrorDetail(error.message) : undefined
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

function isRetryableOpenRouterReason(reason: string): boolean {
  return reason === "openrouter_http_403" || isRetryableSummaryReason("openrouter", reason);
}

function shouldSwitchToFallbackModel(reason: string): boolean {
  return shouldDowngradeZdr(reason) || isRetryableOpenRouterReason(reason);
}

async function parseErrorReason(
  response: Response
): Promise<{ reason: string; detail?: string }> {
  const text = await readErrorText(response);
  const routeUnavailable =
    ZDR_ROUTE_UNAVAILABLE_PATTERN.test(text) || (/provider/i.test(text) && /route/i.test(text));

  return {
    reason: routeUnavailable ? "openrouter_zdr_route_unavailable" : `openrouter_http_${response.status}`,
    detail: extractErrorDetail(text)
  };
}

function shouldDowngradeZdr(reason: string): boolean {
  return reason === "openrouter_zdr_route_unavailable" || reason === "openrouter_http_403";
}
