import type { Env } from "../types";

export type SummaryProvider = "openai" | "openrouter" | "gemini";

export function getRequiredEnv(env: Env, key: keyof Env): string {
  const value = env[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment binding: ${String(key)}`);
  }

  return value.trim();
}

export function getSummaryProvider(env: Env): SummaryProvider {
  const value = env.SUMMARY_PROVIDER?.trim().toLowerCase();

  if (!value || value === "openai") {
    return "openai";
  }

  if (value === "gemini" || value === "openrouter") {
    return value;
  }

  throw new Error("Invalid SUMMARY_PROVIDER");
}

export function getGmailUserId(env: Env): string {
  const userId = env.GMAIL_USER_ID?.trim();

  if (userId) {
    return userId;
  }

  return "me";
}

export function getApiBaseUrl(value: string | undefined, defaultUrl: string): string {
  const base = (value?.trim() || defaultUrl).replace(/\/+$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("API base URL must use HTTPS without credentials, query or fragment");
  }
  return base;
}

export function getTelegramChatId(env: Env): string {
  const id = getRequiredEnv(env, "TG_CHAT_ID");
  if (!/^[1-9]\d*$/.test(id)) {
    throw new Error("TG_CHAT_ID must be the owner's positive private chat ID");
  }
  return id;
}

export function getOpenAIExtraBody(env: Env): Record<string, unknown> {
  const raw = env.OPENAI_EXTRA_BODY?.trim();
  if (!raw) return {};
  let extra: unknown;
  try {
    extra = JSON.parse(raw);
  } catch {
    throw new Error("Invalid OPENAI_EXTRA_BODY JSON");
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    throw new Error("OPENAI_EXTRA_BODY must be a JSON object");
  }
  if (["model", "messages", "stream"].some((key) => Object.hasOwn(extra, key))) {
    throw new Error("OPENAI_EXTRA_BODY cannot override model, messages or stream");
  }
  return extra as Record<string, unknown>;
}
