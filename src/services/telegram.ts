import { getRequiredEnv, getTelegramChatId } from "./config";
import { PRIVACY_ROUTE_NOTICE } from "./summary-error-text";
import type { Env } from "../types";

export class TelegramError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(reason: string, status?: number) {
    super("Telegram request failed");
    this.name = "TelegramError";
    this.reason = reason;
    this.status = status;
  }
}

export interface TelegramCallbackButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramCallbackButton[][];
}

export interface TelegramMessageOptions {
  replyMarkup?: TelegramReplyMarkup;
}

export const TELEGRAM_CALLBACK_VIEW_RAW = "view_raw";
export const TELEGRAM_CALLBACK_BACK_SUMMARY = "back_summary";
export const TELEGRAM_CALLBACK_TRASH_GMAIL = "trash_gmail";

const TELEGRAM_INLINE_CODE_PATTERN = /^验证码:\s*`([^`\n]+)`\s*$/;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TRUNCATION_NOTICE = "（内容过长，已截断。完整邮件请查看邮箱。）";

export async function sendTelegramMessage(
  env: Env,
  text: string,
  options: TelegramMessageOptions = {}
): Promise<{ messageId: number }> {
  const chatId = getTelegramChatId(env);
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: renderHtmlMessage(text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  };

  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  return parseTelegramMessageResult(
    await postTelegram(env, "sendMessage", body)
  );
}

export function buildSummaryKeyboard(
  options: { showDeleteWithGmail?: boolean } = {}
): TelegramReplyMarkup {
  const buttons: TelegramCallbackButton[] = [
    { text: "原文", callback_data: TELEGRAM_CALLBACK_VIEW_RAW }
  ];

  if (options.showDeleteWithGmail) {
    buttons.push({
      text: "🗑 删邮件+消息",
      callback_data: TELEGRAM_CALLBACK_TRASH_GMAIL
    });
  }

  return {
    inline_keyboard: [buttons]
  };
}

export function buildOriginalKeyboard(
  options: { showDeleteWithGmail?: boolean } = {}
): TelegramReplyMarkup {
  const buttons: TelegramCallbackButton[] = [
    { text: "返回摘要", callback_data: TELEGRAM_CALLBACK_BACK_SUMMARY }
  ];

  if (options.showDeleteWithGmail) {
    buttons.push({
      text: "🗑 删邮件+消息",
      callback_data: TELEGRAM_CALLBACK_TRASH_GMAIL
    });
  }

  return {
    inline_keyboard: [buttons]
  };
}

export async function editTelegramMessageText(
  env: Env,
  params: {
    chatId: string;
    messageId: number;
    text: string;
    replyMarkup?: TelegramReplyMarkup;
  }
): Promise<void> {
  if (params.chatId !== getTelegramChatId(env)) {
    throw new TelegramError("private_owner_required");
  }

  const body: Record<string, unknown> = {
    chat_id: params.chatId,
    message_id: params.messageId,
    text: renderHtmlMessage(params.text),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  };

  if (params.replyMarkup) {
    body.reply_markup = params.replyMarkup;
  }

  await postTelegram(env, "editMessageText", body);
}

export async function deleteTelegramMessage(
  env: Env,
  params: { chatId: string; messageId: number }
): Promise<void> {
  if (params.chatId !== getTelegramChatId(env)) {
    throw new TelegramError("private_owner_required");
  }

  await postTelegram(env, "deleteMessage", {
    chat_id: params.chatId,
    message_id: params.messageId
  });
}

export async function answerTelegramCallbackQuery(
  env: Env,
  callbackQueryId: string,
  options: { text?: string; showAlert?: boolean } = {}
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  };

  if (options.text) {
    body.text = options.text;
  }

  if (options.showAlert !== undefined) {
    body.show_alert = options.showAlert;
  }

  await postTelegram(env, "answerCallbackQuery", body);
}

function renderHtmlMessage(text: string): string {
  return limitMessageText(text.replaceAll("\r\n", "\n"))
    .split("\n")
    .map(renderHtmlLine)
    .join("\n");
}

function limitMessageText(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;

  const hasPrivacyNotice = text.endsWith(PRIVACY_ROUTE_NOTICE);
  const body = hasPrivacyNotice ? text.slice(0, -PRIVACY_ROUTE_NOTICE.length).trimEnd() : text;
  const suffix = `\n\n${TELEGRAM_TRUNCATION_NOTICE}${hasPrivacyNotice ? `\n\n${PRIVACY_ROUTE_NOTICE}` : ""}`;
  const limit = TELEGRAM_MESSAGE_LIMIT - suffix.length;
  let end = 0;

  // 在 HTML 转义前按 UTF-16 长度保守计数，裁剪位置保留完整字素（含组合表情）。
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body)) {
    const next = part.index + part.segment.length;
    if (next > limit) break;
    end = next;
  }
  return body.slice(0, end).trimEnd() + suffix;
}

function renderHtmlLine(line: string): string {
  const codeMatch = TELEGRAM_INLINE_CODE_PATTERN.exec(line);

  if (codeMatch) {
    return `验证码: <code>${escapeHtml(codeMatch[1]!)}</code>`;
  }

  return escapeHtml(line);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseTelegramMessageResult(result: unknown): { messageId: number } {
  if (!result || typeof result !== "object") {
    throw new TelegramError("telegram_missing_message_id");
  }

  const messageId = (result as Record<string, unknown>).message_id;

  if (typeof messageId !== "number") {
    throw new TelegramError("telegram_missing_message_id");
  }

  return { messageId };
}

async function postTelegram(
  env: Env,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const token = getRequiredEnv(env, "TG_BOT_TOKEN");
  let response: Response;

  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new TelegramError("telegram_fetch_failed");
  }

  if (!response.ok) {
    throw new TelegramError(`telegram_http_${response.status}`, response.status);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new TelegramError("telegram_invalid_response", response.status);
  }

  if (!payload || typeof payload !== "object") {
    throw new TelegramError("telegram_invalid_response", response.status);
  }

  const record = payload as Record<string, unknown>;

  if (record.ok !== true) {
    throw new TelegramError("telegram_api_error", response.status);
  }

  return record.result;
}
