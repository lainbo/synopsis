export type ChatCompletionResult =
  | { ok: true; summary: string; model: string }
  | { ok: false; reason: string; model?: string };

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 2000);
  }

  const dateMs = Date.parse(value);

  if (!Number.isFinite(dateMs)) {
    return undefined;
  }

  const delayMs = dateMs - Date.now();

  if (delayMs <= 0) {
    return undefined;
  }

  return Math.min(delayMs, 2000);
}

export async function parseChatCompletionResponse(
  response: Response,
  defaultModel: string,
  provider: "openai" | "openrouter"
): Promise<ChatCompletionResult> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { ok: false, reason: `${provider}_invalid_response` };
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: `${provider}_invalid_response` };
  }

  const model = parseResponseModel(payload, defaultModel);
  const choices = (payload as Record<string, unknown>).choices;

  if (!Array.isArray(choices)) {
    return { ok: false, reason: `${provider}_invalid_response`, model };
  }

  const first = choices[0];

  if (!first || typeof first !== "object") {
    return { ok: false, reason: `${provider}_invalid_response`, model };
  }

  const choice = first as Record<string, unknown>;
  const message = choice.message;
  const refusal = message && typeof message === "object"
    ? (message as Record<string, unknown>).refusal
    : undefined;

  if (
    choice.finish_reason === "content_filter" ||
    (typeof refusal === "string" && refusal.trim())
  ) {
    return { ok: false, reason: `${provider}_blocked`, model };
  }

  if (hasTruncatedFinishReason(first)) {
    return { ok: false, reason: `${provider}_output_truncated`, model };
  }

  if (!message || typeof message !== "object") {
    return { ok: false, reason: `${provider}_invalid_response`, model };
  }

  const content = (message as Record<string, unknown>).content;
  const summary = typeof content === "string" ? content.trim() : "";

  if (!summary) {
    return { ok: false, reason: `${provider}_empty_summary`, model };
  }

  return { ok: true, summary, model };
}

function hasTruncatedFinishReason(choice: object): boolean {
  const record = choice as Record<string, unknown>;

  return (
    record.finish_reason === "length" ||
    record.native_finish_reason === "MAX_TOKENS"
  );
}

function parseResponseModel(payload: unknown, defaultModel: string): string {
  if (!payload || typeof payload !== "object") {
    return defaultModel;
  }

  const model = (payload as Record<string, unknown>).model;

  return typeof model === "string" && model.trim() ? model.trim() : defaultModel;
}
