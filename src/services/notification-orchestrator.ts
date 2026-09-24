import { generateEmailSummary, type SummaryResult } from "./email-summary";
import type { ParsedEmailForProcessing } from "./mime-parser";
import {
  mergeProcessingState,
  type ProcessingState
} from "./processing-state";
import { getRequiredEnv, getTelegramChatId } from "./config";
import {
  createEmailCacheEntry,
  putEmailCacheRecord,
  putMessageMapping,
  type CreateEmailCacheEntryResult
} from "./email-cache";
import {
  buildReadableEmailBody,
  buildSummaryInputText
} from "./email-readable-text";
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
  backupProvider?: "gmail" | "cloudflare_email" | "resend";
  backupMessageId?: string;
}

export async function notifyEmailSummary({
  env,
  processingId,
  parsed,
  state,
  cache,
  retryLimit = 3,
  backupProvider,
  backupMessageId
}: NotifyEmailSummaryParams): Promise<void> {
  if (state.telegram_done === true) {
    logInfo("telegram_already_done", { processingId });
    return;
  }

  try {
    const now = () => new Date();
    let summaryPatch: ProcessingState = {};
    const backupPatch: ProcessingState = {
      backup_done: state.backup_done,
      backup_provider: state.backup_provider,
      backup_done_at: state.backup_done_at,
      gmail_message_id: state.gmail_message_id,
      fallback_message_id: state.fallback_message_id,
      backup_error: state.backup_error,
      backup_error_chain: state.backup_error_chain
    };
    const recordTelegramFailure = async (
      stage: NonNullable<ProcessingState["telegram_stage"]>,
      error: unknown,
      extra: Partial<ProcessingState> = {}
    ): Promise<void> => {
      const attempt = (state.telegram_attempts ?? 0) + 1;
      const attemptedAt = now();

      await mergeProcessingState(env.MAIL_KV, processingId, {
        ...backupPatch,
        ...summaryPatch,
        ...extra,
        telegram_done: false,
        telegram_stage: stage,
        telegram_error: getReason(error, stage),
        telegram_attempts: attempt,
        telegram_last_attempt_at: attemptedAt.toISOString(),
        telegram_next_retry_at:
          attempt < retryLimit
            ? new Date(attemptedAt.getTime() + 300000).toISOString()
            : undefined
      });
    };

    let entry: CreateEmailCacheEntryResult;
    try {
      entry = cache ?? await createEmailCacheEntry(env.MAIL_KV, {
        emailId: state.telegram_email_id!,
        parsed,
        summaryText: ""
      });
    } catch {
      await recordTelegramFailure("email_cache_failed", "email_cache_failed");
      return;
    }
    const emailId = entry.emailId;

    const summary = await generateEmailSummary(env, {
      to: parsed.to.join(", "),
      text: buildSummaryInputText(parsed),
      subject: parsed.subject
    });

    summaryPatch = buildSummaryStatePatch(summary);

    const telegram_variant = summary.ok ? "summary" : "summary_placeholder";
    const message = buildTelegramText(parsed, summary);
    const gmailMessageId =
      backupProvider === "gmail" ? backupMessageId ?? state.gmail_message_id : undefined;

    try {
      await putEmailCacheRecord(env.MAIL_KV, emailId, {
        ...entry.record,
        summaryText: message,
        summary
      });
    } catch {
      await recordTelegramFailure("email_cache_failed", "email_cache_failed", {
        telegram_variant
      });
      return;
    }

    let telegram: { messageId: number };

    try {
      telegram = await sendTelegramMessage(env, message, {
        replyMarkup: buildSummaryKeyboard({
          showDeleteWithGmail: Boolean(gmailMessageId)
        })
      });
    } catch (error) {
      await recordTelegramFailure("send_message_failed", error, {
        telegram_email_id: emailId,
        telegram_variant
      });
      return;
    }

    try {
      await putMessageMapping(env.MAIL_KV, telegram.messageId, {
        emailId,
        chatId: getTelegramChatId(env),
        messageId: telegram.messageId,
        gmailMessageId,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      await recordTelegramFailure("message_sent_mapping_failed", error, {
        telegram_email_id: emailId,
        telegram_message_id: telegram.messageId,
        telegram_variant
      });
      return;
    }

    await mergeProcessingState(env.MAIL_KV, processingId, {
      ...backupPatch,
      ...summaryPatch,
      telegram_done: true,
      telegram_done_at: new Date().toISOString(),
      telegram_error: undefined,
      telegram_email_id: emailId,
      telegram_message_id: telegram.messageId,
      telegram_variant,
      telegram_stage: "done",
      telegram_next_retry_at: undefined
    });

    await maybeSendFallbackModelAlert(env, summary);

    logInfo("telegram_notification_done", {
      processingId,
      telegram_message_id: telegram.messageId
    });
  } catch (error) {
    logError("email_notification_unexpected_failed", error, { processingId });
  }
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

export function buildSummaryStatePatch(
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

function buildTelegramText(
  parsed: ParsedEmailForProcessing,
  summary: SummaryResult
): string {
  return withPrivacyRouteNotice(
    summary.ok ? summary.summary : buildPlaceholder(parsed, summary),
    summary.privacyDowngraded
  );
}

function buildPlaceholder(
  parsed: ParsedEmailForProcessing,
  summary: Extract<SummaryResult, { ok: false }>
): string {
  const backupText = "原件已完成备份，可查看原文。";

  if (parsed.parse_skipped_reason === "skipped_large_email") {
    return `邮件较大，已跳过 AI 摘要，${backupText}`;
  }

  if (parsed.parse_done === false) {
    return `邮件正文解析失败，已保留原件备份，${backupText}`;
  }

  if (!buildReadableEmailBody(parsed)) {
    return `邮件正文为空，无法生成摘要，${backupText}`;
  }

  return `${formatSummaryFailureForTelegram(summary.reason, {
    detail: summary.detail,
    privacyDowngraded: summary.privacyDowngraded
  })}，${backupText}`;
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
