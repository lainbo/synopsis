import type { Context } from "hono";
import {
  deleteEmailCacheRecord,
  deleteMessageMapping,
  getEmailCacheRecord,
  getMessageMapping,
  putMessageMapping,
  type EmailCacheRecord,
  type MessageMapping
} from "../services/email-cache";
import {
  getRequiredEnv,
  getTelegramChatId,
  PRIMARY_GMAIL_ACCOUNT
} from "../services/config";
import { buildSummaryInputText } from "../services/email-readable-text";
import { trashGmailMessage } from "../services/gmail-backup";
import { generateEmailSummary } from "../services/email-summary";
import { isSummarySkipped } from "../services/notification-orchestrator";
import { sendGmailTrashFailedAlert } from "../services/reliability-alerts";
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
  sendTelegramMessage,
  TELEGRAM_CALLBACK_BACK_SUMMARY,
  TELEGRAM_CALLBACK_TRASH_GMAIL,
  TELEGRAM_CALLBACK_VIEW_RAW
} from "../services/telegram";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

type AppContext = Context<{ Bindings: Env }>;

const TELEGRAM_DELETE_PARTIAL_SUCCESS_TEXT =
  "Gmail 邮件已在垃圾箱或已不存在，但 Telegram 消息删除失败，请重试或手动删除";
const GMAIL_TRASH_RETRY_TEXT = "Gmail 邮件处理失败，消息已保留，请稍后重试";

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
    await answerUnavailable(c.env, parsed);
    return c.json({ ok: true });
  }

  const expectedChatId = getTelegramChatId(c.env);

  if (parsed.chatType !== "private" || parsed.chatId !== expectedChatId || parsed.senderId !== expectedChatId) {
    logInfo("telegram_callback_rejected", {
      reason: "private_owner_required",
      messageId: parsed.messageId
    });
    await answerUnavailable(c.env, parsed);
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
    await answerUnavailable(c.env, parsed);
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_TRASH_GMAIL) {
    await answerThenTrash(c, parsed, mapping);
    return c.json({ ok: true });
  }

  const record = await getEmailCacheRecord(c.env.MAIL_KV, mapping.emailId);

  if (!record) {
    await answerCallback(c.env, parsed, {
      text: "邮件缓存已过期或已删除"
    });
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_VIEW_RAW) {
    await answerThenEdit(c, parsed, () => ({
      text: buildOriginalText(record),
      replyMarkup: buildOriginalKeyboard({
        showDeleteWithGmail: Boolean(mapping.gmailMessageId)
      })
    }));
    return c.json({ ok: true });
  }

  if (parsed.action === TELEGRAM_CALLBACK_BACK_SUMMARY) {
    await answerThenEdit(
      c,
      parsed,
      async () => {
        const text = await regenerateSummaryText(c.env, record);

        return {
          text,
          replyMarkup: buildSummaryKeyboard({
            showDeleteWithGmail: Boolean(mapping.gmailMessageId)
          })
        };
      },
      "正在重新生成摘要…"
    );
    return c.json({ ok: true });
  }

  await answerUnavailable(c.env, parsed);
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

async function answerThenEdit(
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
      }>,
  answerText?: string
): Promise<void> {
  if (!(await answerCallback(c.env, parsed, { text: answerText }))) {
    return;
  }

  try {
    const next = await build();

    await editTelegramMessageText(c.env, {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      text: next.text,
      replyMarkup: next.replyMarkup
    });

    logInfo("telegram_callback_done", {
      action: parsed.action,
      messageId: parsed.messageId
    });
  } catch (error) {
    logError("telegram_callback_edit_failed", error, {
      messageId: parsed.messageId
    });
  }
}

async function regenerateSummaryText(
  env: Env,
  record: EmailCacheRecord
): Promise<string> {
  // 超大或解析失败的邮件没有缓存正文，重新请求 AI 得不到有效摘要，沿用首次通知的说明。
  if (isSummarySkipped(record.summary)) {
    return record.summaryText;
  }

  let summary;

  try {
    summary = await generateEmailSummary(env, {
      to: record.metadata.to.join(", "),
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

// 回调不带点击时间，只有应答结果能判断点击是否过期，所以执行操作前先应答。
// 应答失败时不再执行，也不向外抛：webhook 返回 500 会让 Telegram 重试，并堵住本人后续的点击。
async function answerCallback(
  env: Env,
  parsed: ParsedCallback,
  options: { text?: string; showAlert?: boolean } = {}
): Promise<boolean> {
  try {
    await answerTelegramCallbackQuery(env, parsed.callbackId, options);
    return true;
  } catch (error) {
    logError("telegram_callback_answer_failed", error, {
      action: parsed.action,
      messageId: parsed.messageId
    });
    return false;
  }
}

async function answerUnavailable(env: Env, parsed: ParsedCallback): Promise<void> {
  await answerCallback(env, parsed, {
    text: "操作不可用或已过期",
    showAlert: true
  });
}

async function answerThenTrash(
  c: AppContext,
  parsed: ParsedCallback,
  mapping: MessageMapping
): Promise<void> {
  const gmailMessageId = mapping.gmailMessageId;

  if (!gmailMessageId) {
    await answerCallback(c.env, parsed, {
      text: "未找到可移入垃圾箱的 Gmail 备份",
      showAlert: true
    });
    return;
  }

  if (!(await answerCallback(c.env, parsed, { text: "🗑 正在删除" }))) {
    return;
  }

  const telegramDeleted = await tryDeleteTelegramMessage(
    c,
    parsed,
    mapping.chatId
  );

  if (telegramDeleted) {
    // 消息先消失，Gmail 在响应后处理；失败时另发带重试按钮的提示。
    c.executionCtx.waitUntil(trashGmailInBackground(c.env, mapping, gmailMessageId));
    await deleteMessageMapping(c.env.MAIL_KV, parsed.messageId).catch((error) => {
      logError("telegram_delete_cleanup_failed", error, {
        messageId: parsed.messageId
      });
    });
    return;
  }

  // 消息删不掉时（例如超过 Telegram 48 小时删除期限）按钮仍在，当场处理 Gmail。回调已应答，结果另发消息告知。
  const notice = await trashMappedGmail(c.env, mapping, gmailMessageId).then(
    () => TELEGRAM_DELETE_PARTIAL_SUCCESS_TEXT,
    () => GMAIL_TRASH_RETRY_TEXT
  );

  await sendTelegramMessage(c.env, notice).catch((error) => {
    logError("telegram_delete_notice_failed", error, {
      messageId: parsed.messageId
    });
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

async function trashMappedGmail(
  env: Env,
  mapping: MessageMapping,
  gmailMessageId: string
): Promise<void> {
  const gmailAccount = mapping.gmailAccount ?? PRIMARY_GMAIL_ACCOUNT;

  try {
    await trashGmailMessage(env, gmailAccount, gmailMessageId);
  } catch (error) {
    logError("gmail_trash_failed", error, {
      messageId: mapping.messageId,
      gmail_account: gmailAccount,
      gmail_message_id: gmailMessageId
    });
    throw error;
  }
}

async function trashGmailInBackground(
  env: Env,
  mapping: MessageMapping,
  gmailMessageId: string
): Promise<void> {
  try {
    await trashMappedGmail(env, mapping, gmailMessageId);
  } catch (error) {
    await sendTrashRetryNotice(env, mapping, error);
    return;
  }

  await deleteEmailCacheRecord(env.MAIL_KV, mapping.emailId).catch((error) => {
    logError("telegram_delete_cleanup_failed", error, {
      messageId: mapping.messageId
    });
  });
}

async function sendTrashRetryNotice(
  env: Env,
  mapping: MessageMapping,
  trashError: unknown
): Promise<void> {
  const record = await getEmailCacheRecord(env.MAIL_KV, mapping.emailId);
  const alert = await sendGmailTrashFailedAlert(env, record?.metadata, trashError);

  if (!alert.ok) {
    logError("gmail_trash_alert_failed", alert.reason, {
      messageId: mapping.messageId
    });
    return;
  }

  // 重试按钮沿用原映射的 Gmail 账号和消息 ID，正文缓存保留到移入垃圾箱成功。
  await putMessageMapping(env.MAIL_KV, alert.messageId, {
    ...mapping,
    messageId: alert.messageId,
    createdAt: new Date().toISOString()
  }).catch((error) => {
    logError("gmail_trash_alert_mapping_failed", error, {
      messageId: alert.messageId
    });
  });
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
  return `${headerLines.join("\n")}\n\n${body}`;
}
