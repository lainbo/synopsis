export interface SummaryFailureTextOptions {
  detail?: string;
  privacyDowngraded?: boolean;
}

export function formatSummaryFailureForTelegram(
  reason: string,
  options: SummaryFailureTextOptions = {}
): string {
  const normalized = normalizeSummaryReason(reason);
  const httpStatus = parseProviderHttpStatus(normalized);
  const detail = normalizeDetail(options.detail);

  if (httpStatus !== undefined) {
    return withDetail(formatProviderHttpFailure(httpStatus, options), detail);
  }

  const fallback = (() => {
    switch (normalized) {
    case "summary_config_invalid":
      return "AI 摘要配置异常：SUMMARY_PROVIDER 只能是 openai、openrouter 或 gemini";
    case "openai_config_invalid":
      return "AI 摘要配置异常：请检查 OPENAI_MODEL、OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_EXTRA_BODY";
    case "openai_timeout":
      return "AI 摘要失败：OpenAI 兼容接口请求超时";
    case "openai_fetch_failed":
      return "AI 摘要失败：OpenAI 兼容接口网络请求失败";
    case "openai_invalid_response":
      return "AI 摘要失败：OpenAI 兼容接口响应格式无效";
    case "openai_empty_summary":
      return "AI 摘要失败：OpenAI 兼容接口返回空摘要";
    case "openai_output_truncated":
      return "AI 摘要失败：OpenAI 兼容接口输出被截断";
    case "openai_blocked":
      return "AI 摘要失败：OpenAI 兼容接口拒绝生成摘要";
    case "openrouter_config_invalid":
      return "AI 摘要配置异常：请检查 OPENROUTER_MODEL、OPENROUTER_API_KEY 和 OPENROUTER_BASE_URL";
    case "openrouter_timeout":
      return "AI 摘要失败：OpenRouter 请求超时";
    case "openrouter_fetch_failed":
      return "AI 摘要失败：OpenRouter 网络请求失败";
    case "openrouter_invalid_response":
      return "AI 摘要失败：OpenRouter 响应格式无效";
    case "openrouter_empty_summary":
      return "AI 摘要失败：OpenRouter 返回空摘要";
    case "openrouter_output_truncated":
      return "AI 摘要失败：OpenRouter 输出被截断";
    case "openrouter_blocked":
      return "AI 摘要失败：OpenRouter 拒绝生成摘要";
    case "openrouter_zdr_route_unavailable":
      return "AI 摘要失败：OpenRouter 无可用 ZDR provider";
    case "gemini_config_invalid":
      return "AI 摘要配置异常：请检查 GEMINI_MODEL、GEMINI_API_KEY 和 GEMINI_BASE_URL";
    case "gemini_timeout":
      return "AI 摘要失败：Gemini 请求超时";
    case "gemini_fetch_failed":
      return "AI 摘要失败：Gemini 网络请求失败";
    case "gemini_invalid_response":
      return "AI 摘要失败：Gemini 响应格式无效";
    case "gemini_empty_summary":
      return "AI 摘要失败：Gemini 返回空摘要";
    case "gemini_output_truncated":
      return "AI 摘要失败：Gemini 输出被截断";
    case "gemini_blocked":
      return "AI 摘要失败：Gemini 拒绝生成摘要";
    default:
      return `AI 摘要失败：${normalized}`;
    }
  })();

  return withDetail(fallback, detail);
}

export function formatSummaryExceptionForTelegram(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.includes("Missing required environment binding")
  ) {
    if (error.message.includes("GEMINI_")) {
      return formatSummaryFailureForTelegram("gemini_config_invalid");
    }

    if (error.message.includes("OPENROUTER_")) {
      return formatSummaryFailureForTelegram("openrouter_config_invalid");
    }

    return formatSummaryFailureForTelegram("summary_config_invalid");
  }

  if (
    error instanceof Error &&
    error.message.includes("Invalid SUMMARY_PROVIDER")
  ) {
    return formatSummaryFailureForTelegram("summary_config_invalid");
  }

  return "AI 摘要失败：请求异常，请检查配置或稍后重试";
}

function normalizeSummaryReason(reason: string): string {
  const normalized = reason.trim();

  return normalized || "unknown_summary_error";
}

function parseProviderHttpStatus(
  reason: string
): { provider: "OpenAI 兼容接口" | "OpenRouter" | "Gemini"; status: number } | undefined {
  const openai = /^openai_http_(\d{3})$/.exec(reason);
  if (openai) return { provider: "OpenAI 兼容接口", status: Number(openai[1]) };

  const openrouter = /^openrouter_http_(\d{3})$/.exec(reason);

  if (openrouter) {
    return { provider: "OpenRouter", status: Number(openrouter[1]) };
  }

  const gemini = /^gemini_http_(\d{3})$/.exec(reason);

  if (gemini) {
    return { provider: "Gemini", status: Number(gemini[1]) };
  }

  return undefined;
}

function formatProviderHttpFailure(
  parsed: { provider: "OpenAI 兼容接口" | "OpenRouter" | "Gemini"; status: number },
  options: SummaryFailureTextOptions
): string {
  const { provider, status } = parsed;

  if (status === 401) {
    return `AI 摘要配置异常：${provider} HTTP 401（认证失败）`;
  }

  if (status === 403) {
    return provider === "OpenRouter" && options.privacyDowngraded
      ? "AI 摘要失败：OpenRouter HTTP 403（ZDR 降级后仍失败）"
      : `AI 摘要失败：${provider} HTTP 403`;
  }

  if (status === 429) {
    return `AI 摘要失败：${provider} HTTP 429（请求被限流）`;
  }

  return `AI 摘要失败：${provider} HTTP ${status}`;
}

function normalizeDetail(detail: string | undefined): string | undefined {
  const normalized = detail?.trim();

  return normalized || undefined;
}

function withDetail(message: string, detail: string | undefined): string {
  if (!detail) {
    return message;
  }

  return `${message}：${detail}`;
}

export const PRIVACY_ROUTE_NOTICE =
  "隐私路由提示：本次已取消请求中的 ZDR（供应商不保留请求数据）限制后重试。实际数据保留规则以供应商和账号设置为准。";

export function withPrivacyRouteNotice(text: string, privacyDowngraded: boolean): string {
  return privacyDowngraded && !text.endsWith(PRIVACY_ROUTE_NOTICE)
    ? `${text}\n\n${PRIVACY_ROUTE_NOTICE}`
    : text;
}
