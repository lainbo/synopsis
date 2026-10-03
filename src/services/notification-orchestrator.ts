import { generateEmailSummary, type SummaryResult } from "./email-summary";
import type { ParsedEmailForProcessing } from "./mime-parser";
import {
  mergeProcessingState,
  type ProcessingState
} from "./processing-state";
import {
  getRequiredEnv,
  getTelegramChatId,
  getTelegramRetryLimit,
  TELEGRAM_RETRY_DELAY_MS
} from "./config";
import {
  getOrCreateEmailCacheEntry,
  putEmailCacheRecord,
  putMessageMapping,
  type CreateEmailCacheEntryResult
} from "./email-cache";
import { buildSummaryInputText } from "./email-readable-text";
import {
  buildSummaryKeyboard,
  sendTelegramMessage
} from "./telegram";
import { sendAiSummaryFallbackModelAlert } from "./reliability-alerts";
import { formatSummaryFailureForTelegram, withPrivacyRouteNotice } from "./summary-error-text";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

export interface NotifyEmailSummaryParams {
  env: Env;
  processingId: string;
  parsed: ParsedEmailForProcessing;
  state: ProcessingState;
  cache?: CreateEmailCacheEntryResult;
  retryLimit?: number;
}

export async function notifyEmailSummary({
  env,
  processingId,
  parsed,
  state,
  cache,
  retryLimit = getTelegramRetryLimit(env)
}: NotifyEmailSummaryParams): Promise<void> {
  if (state.backup_done !== true || state.telegram_done === true) {
    return;
  }

  const attemptedAt = new Date();
  const attempt = (state.telegram_attempts ?? 0) + 1;
  const emailId = state.telegram_email_id;
  const gmailMessageId = state.backup_provider === "gmail" ? state.gmail_message_id : undefined;
  let messageId = state.telegram_message_id;
  let stage: NonNullable<ProcessingState["telegram_stage"]> = "email_cache_failed";
  let summary: SummaryResult | undefined;
  let summaryPatch: ProcessingState = {};
  let variant = state.telegram_variant;
  const backupPatch: ProcessingState = {
    backup_done: state.backup_done,
    backup_provider: state.backup_provider,
    backup_done_at: state.backup_done_at,
    gmail_message_id: state.gmail_message_id,
    fallback_message_id: state.fallback_message_id,
    backup_error: state.backup_error,
    backup_error_chain: state.backup_error_chain
  };

  try {
    if (!emailId) {
      throw new Error("Notification cache ID is missing");
    }

    // 已取得消息编号后只修复映射和状态，不能再次发送消息。
    if (messageId === undefined) {
      const entry = cache ?? await getOrCreateEmailCacheEntry(env.MAIL_KV, {
        emailId,
        parsed,
        summaryText: ""
      });
      summary = entry.record.summary;
      let text = entry.record.summaryText;

      if (!text) {
        summary ??= await generateNotificationSummary(env, parsed, entry.record.text);
        text = buildTelegramText(summary);
      }

      if (summary) {
        summaryPatch = buildSummaryStatePatch(summary);
        variant = summary.ok ? "summary" : "summary_placeholder";
      }

      if (!entry.record.summaryText) {
        await putEmailCacheRecord(env.MAIL_KV, emailId, {
          ...entry.record,
          summaryText: text,
          summary
        });
      }

      stage = "send_message_failed";
      const telegram = await sendTelegramMessage(env, withPrivacyRouteNotice(
        text,
        summary?.privacyDowngraded ?? state.summary_privacy_downgraded ?? false
      ), {
        replyMarkup: buildSummaryKeyboard({
          showDeleteWithGmail: Boolean(gmailMessageId)
        })
      });
      messageId = telegram.messageId;
    }

    stage = "message_sent_mapping_failed";
    await putMessageMapping(env.MAIL_KV, messageId, {
      emailId,
      chatId: getTelegramChatId(env),
      messageId,
      gmailMessageId,
      createdAt: attemptedAt.toISOString()
    });
    stage = "message_sent_state_failed";
    await mergeProcessingState(env.MAIL_KV, processingId, {
      ...backupPatch,
      ...summaryPatch,
      telegram_done: true,
      telegram_done_at: new Date().toISOString(),
      telegram_error: undefined,
      telegram_email_id: emailId,
      telegram_message_id: messageId,
      telegram_variant: variant,
      telegram_stage: "done",
      telegram_attempts: attempt,
      telegram_last_attempt_at: attemptedAt.toISOString(),
      telegram_next_retry_at: undefined
    });
  } catch (error) {
    await mergeProcessingState(env.MAIL_KV, processingId, {
      ...backupPatch,
      ...summaryPatch,
      telegram_done: false,
      telegram_stage: stage,
      telegram_error: getReason(error, stage),
      telegram_email_id: emailId,
      telegram_message_id: messageId,
      telegram_variant: variant,
      telegram_attempts: attempt,
      telegram_last_attempt_at: attemptedAt.toISOString(),
      telegram_next_retry_at: attempt < retryLimit
        ? new Date(Date.now() + TELEGRAM_RETRY_DELAY_MS).toISOString()
        : undefined
    });
    return;
  }

  if (summary) {
    await maybeSendFallbackModelAlert(env, summary);
  }
  logInfo("telegram_notification_done", {
    processingId,
    telegram_message_id: messageId
  });
}

const SKIPPED_SUMMARY_REASONS = new Set(["summary_skipped_large_email", "summary_parse_failed"]);

export function isSummarySkipped(summary: SummaryResult | undefined): boolean {
  return summary?.ok === false && SKIPPED_SUMMARY_REASONS.has(summary.reason);
}

async function generateNotificationSummary(
  env: Env,
  parsed: ParsedEmailForProcessing,
  text: string
): Promise<SummaryResult> {
  if (parsed.parse_skipped_reason === "skipped_large_email") {
    return skippedSummary("summary_skipped_large_email");
  }

  if (!parsed.parse_done) {
    return skippedSummary("summary_parse_failed");
  }

  return generateEmailSummary(env, {
    to: parsed.to.join(", "),
    text: buildSummaryInputText({ ...parsed, text, html: "" })
  });
}

function skippedSummary(reason: string): SummaryResult {
  return { ok: false, reason, privacyDowngraded: false, fallbackModelUsed: false };
}

async function maybeSendFallbackModelAlert(
  env: Env,
  summary: SummaryResult
): Promise<void> {
  if (!summary.ok || summary.fallbackModelUsed !== true) {
    return;
  }

  const alert = await sendAiSummaryFallbackModelAlert(env, {
    primaryModel: getRequiredEnv(env, "OPENROUTER_MODEL"),
    fallbackModel: summary.model,
    reason: "openrouter_primary_model_failed"
  });

  if (!alert.ok) {
    logError("ai_summary_fallback_model_alert_failed", alert.reason);
  }
}

function buildSummaryStatePatch(
  result: SummaryResult
): ProcessingState {
  if (result.ok) {
    return {
      summary_done: true,
      summary_done_at: new Date().toISOString(),
      summary_error: undefined,
      summary_error_detail: undefined,
      summary_privacy_downgraded: result.privacyDowngraded,
      summary_fallback_model_used: result.fallbackModelUsed,
      summary_model: result.model
    };
  }

  return {
    summary_done: false,
    summary_error: result.reason,
    summary_error_detail: result.detail,
    summary_privacy_downgraded: result.privacyDowngraded,
    summary_fallback_model_used: result.fallbackModelUsed,
    summary_model: result.model
  };
}

function buildTelegramText(summary: SummaryResult): string {
  return withPrivacyRouteNotice(
    summary.ok ? summary.summary : `${formatSummaryFailureForTelegram(summary.reason, {
      detail: summary.detail,
      privacyDowngraded: summary.privacyDowngraded
    })}，原件已完成备份，完整内容请查看邮箱。`,
    summary.privacyDowngraded
  );
}

function getReason(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;

    if (typeof reason === "string" && reason.trim()) {
      return reason.trim();
    }
  }

  return fallback;
}
