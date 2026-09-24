import type { Context } from "hono";
import {
  deleteEmailCacheRecord,
  deleteMessageMapping,
  getEmailCacheRecord,
  getMessageMapping,
  type EmailCacheRecord,
  type MessageMapping
} from "../services/email-cache";
import { getRequiredEnv, getTelegramChatId } from "../services/config";
import { buildSummaryInputText } from "../services/email-readable-text";
import { trashGmailMessage } from "../services/gmail-backup";
import { generateEmailSummary } from "../services/email-summary";
import {
  formatSummaryExceptionForTelegram,
  formatSummaryFailureForTelegram,
  withPrivacyRouteNotice
} from "../services/summary-error-text";
import {
  answerTelegramCallbackQuery,
  buildOriginalKeyboard,
  buildSummaryKeyboard,
  deleteTelegramMessage,
  editTelegramMessageText,
  TELEGRAM_CALLBACK_BACK_SUMMARY,
  TELEGRAM_CALLBACK_TRASH_GMAIL,
  TELEGRAM_CALLBACK_VIEW_RAW
} from "../services/telegram";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

type AppContext = Context<{ Bindings: Env }>;

const TELEGRAM_DELETE_PARTIAL_SUCCESS_TEXT =
  "Gmail 邮件已在垃圾箱或已不存在，但 Telegram 消息删除失败，请重试或手动删除";

interface TelegramCallbackUpdate {
  callback_query?: {
    id?: unknown;
    data?: unknown;
    from?: { id?: unknown };
    message?: {
      message_id?: unknown;
      chat?: {
        id?: unknown;
        type?: unknown;
      };
      reply_markup?: unknown;
    };
  };
}

interface ParsedCallback {
  callbackId: string;
  action: string;
  messageId: number;
  chatId: string;
  senderId: string;
  chatType: unknown;
}

export async function telegramCallbackHandler(c: AppContext): Promise<Response> {
  const expectedSecret = getWebhookSecret(c);

  if (
    !expectedSecret ||
    c.req.header("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramCallbackUpdate;

  try {
    update = await c.req.json<TelegramCallbackUpdate>();
  } catch {
    return c.json({ ok: true });
  }

  const parsed = parseCallback(update);

  if (!parsed) {
    logInfo("telegram_callback_ignored", { reason: "unparseable_callback" });
    return c.json({ ok: true });
  }

  if (
    parsed.action !== TELEGRAM_CALLBACK_VIEW_RAW &&
    parsed.action !== TELEGRAM_CALLBACK_BACK_SUMMARY &&
    parsed.action !== TELEGRAM_CALLBACK_TRASH_GMAIL
  ) {
    await answerUnavailable(c.env, parsed.callbackId);
    return c.json({ ok: true });
  }

  const expectedChatId = getTelegramChatId(c.env);

  if (parsed.chatType !== "private" || parsed.chatId !== expectedChatId || parsed.senderId !== expectedChatId) {
    logInfo("telegram_callback_rejected", {
      reason: "private_owner_required",
      messageId: parsed.messageId
    });
    await answerUnavailable(c.env, parsed.callbackId);
    return c.json({ ok: true });
  }

  logInfo("telegram_callback_received", {
    action: parsed.action,
    messageId: parsed.messageId
  });

  const mapping = await getMessageMapping(c.env.MAIL_KV, parsed.messageId);

  if (!mapping || mapping.chatId !== parsed.chatId) {
    logInfo("telegram_callback_rejected", {
      reason: "mapping_missing_or_mismatch",
      messageId: parsed.messageId
    });
    await answerUnavailable(c.env, parsed.callbackId);
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_TRASH_GMAIL) {
    await trashGmailOrAnswer(c, parsed, mapping);
    return c.json({ ok: true });
  }

  const record = await getEmailCacheRecord(c.env.MAIL_KV, mapping.emailId);

  if (!record) {
    await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
      text: "邮件缓存已过期或已删除"
    });
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_VIEW_RAW) {
    await editOrAnswer(c, parsed, () => ({
      text: buildOriginalText(record),
      replyMarkup: buildOriginalKeyboard({
        showDeleteWithGmail: Boolean(mapping.gmailMessageId)
      })
    }));
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_BACK_SUMMARY) {
    await editOrAnswer(c, parsed, async () => {
      const text = await regenerateSummaryText(c.env, record);

      return {
        text,
        replyMarkup: buildSummaryKeyboard({
          showDeleteWithGmail: Boolean(mapping.gmailMessageId)
        })
      };
    });
    return c.json({ ok: true });
  }

  await answerUnavailable(c.env, parsed.callbackId);
  return c.json({ ok: true });
}

function parseCallback(update: TelegramCallbackUpdate): ParsedCallback | null {
  const callback = update?.callback_query;
  const callbackId = typeof callback?.id === "string" ? callback.id : "";
  const action = typeof callback?.data === "string" ? callback.data : "";
  const messageId = callback?.message?.message_id;
  const chatId = callback?.message?.chat?.id;

  if (!callbackId || typeof messageId !== "number") {
    return null;
  }

  return {
    callbackId,
    action,
    messageId,
    chatId: String(chatId ?? ""),
    senderId: String(callback?.from?.id ?? ""),
    chatType: callback?.message?.chat?.type
  };
}

async function editOrAnswer(
  c: AppContext,
  parsed: ParsedCallback,
  build: () =>
    | {
        text: string;
        replyMarkup: ReturnType<typeof buildSummaryKeyboard>;
      }
    | Promise<{
        text: string;
        replyMarkup: ReturnType<typeof buildSummaryKeyboard>;
      }>
): Promise<void> {
  try {
    const next = await build();

    await editTelegramMessageText(c.env, {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      text: next.text,
      replyMarkup: next.replyMarkup
    });

    await answerTelegramCallbackQuery(c.env, parsed.callbackId);
    logInfo("telegram_callback_done", {
      action: parsed.action,
      messageId: parsed.messageId
    });
  } catch (error) {
    logError("telegram_callback_edit_failed", error, {
      messageId: parsed.messageId
    });
    await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
      text: "操作失败，请稍后重试",
      showAlert: true
    });
  }
}

async function regenerateSummaryText(
  env: Env,
  record: EmailCacheRecord
): Promise<string> {
  let summary;

  try {
    summary = await generateEmailSummary(env, {
      to: record.metadata.to.join(", "),
      subject: record.metadata.subject,
      text: buildSummaryInputText({
        parse_done: true,
        from: record.metadata.from,
        to: record.metadata.to,
        subject: record.metadata.subject,
        text: record.text,
        html: "",
        date: record.metadata.date,
        messageId: record.metadata.messageId,
        headers: []
      })
    });
  } catch (error) {
    return `${formatSummaryExceptionForTelegram(error)}，请稍后重试。`;
  }

  if (summary.ok) {
    return withPrivacyRouteNotice(summary.summary, summary.privacyDowngraded);
  }

  return withPrivacyRouteNotice(`${formatSummaryFailureForTelegram(summary.reason, {
    detail: summary.detail,
    privacyDowngraded: summary.privacyDowngraded
  })}，请稍后重试。`, summary.privacyDowngraded);
}

async function answerUnavailable(env: Env, callbackId: string): Promise<void> {
  await answerTelegramCallbackQuery(env, callbackId, {
    text: "操作不可用或已过期",
    showAlert: true
  });
}

async function trashGmailOrAnswer(
  c: AppContext,
  parsed: ParsedCallback,
  mapping: MessageMapping
): Promise<void> {
  const gmailMessageId = mapping.gmailMessageId;

  if (!gmailMessageId) {
    await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
      text: "未找到可移入垃圾箱的 Gmail 备份",
      showAlert: true
    });
    return;
  }

  try {
    await trashGmailMessage(c.env, gmailMessageId);
  } catch (error) {
    logError("gmail_trash_failed", error, {
      messageId: parsed.messageId,
      gmail_message_id: gmailMessageId
    });
    await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
      text: "Gmail 邮件处理失败，消息已保留，请稍后重试",
      showAlert: true
    });
    return;
  }

  const telegramDeleted = await tryDeleteTelegramMessage(
    c,
    parsed,
    mapping.chatId
  );

  if (!telegramDeleted) {
    await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
      text: TELEGRAM_DELETE_PARTIAL_SUCCESS_TEXT
    });
    return;
  }

  await cleanupDeletedCallbackState(c, parsed.messageId, mapping.emailId);
  await answerTelegramCallbackQuery(c.env, parsed.callbackId, {
    text: "✅ 已删除"
  });
}

async function tryDeleteTelegramMessage(
  c: AppContext,
  parsed: ParsedCallback,
  chatId: string
): Promise<boolean> {
  try {
    await deleteTelegramMessage(c.env, {
      chatId,
      messageId: parsed.messageId
    });
    return true;
  } catch (error) {
    logError("telegram_delete_failed", error, {
      messageId: parsed.messageId
    });
    return false;
  }
}

async function cleanupDeletedCallbackState(
  c: AppContext,
  messageId: number,
  emailId: string
): Promise<void> {
  const cleanupResults = await Promise.allSettled([
    deleteMessageMapping(c.env.MAIL_KV, messageId),
    deleteEmailCacheRecord(c.env.MAIL_KV, emailId)
  ]);
  const cleanupFailure = cleanupResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (cleanupFailure) {
    logError("telegram_delete_cleanup_failed", cleanupFailure.reason, {
      messageId
    });
  }
}

function getWebhookSecret(c: AppContext): string | null {
  try {
    return getRequiredEnv(c.env, "TG_WEBHOOK_SECRET");
  } catch {
    return null;
  }
}

function buildOriginalText(record: EmailCacheRecord): string {
  const headerLines = [
    record.metadata.from ? `发件人: ${record.metadata.from}` : null,
    record.metadata.to.length > 0 ? `收件人: ${record.metadata.to.join(", ")}` : null,
    record.metadata.subject ? `主题: ${record.metadata.subject}` : null,
    record.metadata.date ? `时间: ${record.metadata.date}` : null
  ].filter((line): line is string => Boolean(line));
  const body = record.text || "(无纯文本正文)";
  let text = `${headerLines.join("\n")}\n\n${body}`;

  // Telegram 的 4096 上限按 entities 解析后的文本计数，HTML 转义不影响长度，
  // 因此这里直接用原始字符数截断即可。
  if (text.length > 3900) {
    const truncationNote = "已截断，完整内容请查看邮箱";

    text = `${headerLines.join("\n")}\n\n${body.slice(
      0,
      3500
    )}\n\n${truncationNote}`;
  }

  return text.length > 3900 ? text.slice(0, 3900) : text;
}
