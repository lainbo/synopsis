import { withPrivacyRouteNotice } from "./summary-error-text";
import {
  getEmailCacheRecord,
  getMessageMapping,
  putMessageMapping
} from "./email-cache";
import { buildSummaryInputText } from "./email-readable-text";
import type { ParsedEmailForProcessing } from "./mime-parser";
import { generateEmailSummary } from "./email-summary";
import { buildSummaryStatePatch, notifyEmailSummary } from "./notification-orchestrator";
import {
  mergeProcessingState,
  loadProcessingState,
  type ProcessingState
} from "./processing-state";
import {
  retryGmailAuthAlert,
  sanitizeAlertReason,
  sendCriticalBackupAlert,
  sendFallbackBackupAlert
} from "./reliability-alerts";
import {
  buildSummaryKeyboard,
  editTelegramMessageText,
  sendTelegramMessage
} from "./telegram";
import { getTelegramChatId } from "./config";
import type { Env } from "../types";
import { logError } from "../utils/logging";

const PROCESSING_PREFIX = "processing:";
const DEFAULT_RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const FINAL_ALERT_TTL_SECONDS = 604800;

export interface RunTelegramCompensationOptions {
  now?: Date;
}

export async function runTelegramCompensation(
  env: Env,
  options: RunTelegramCompensationOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const retryLimit = getRetryLimit(env);

  await compensateProcessingStates(env, now, retryLimit);
  await retryGmailAuthAlert(env, { now, retryLimit });
}

async function compensateProcessingStates(
  env: Env,
  now: Date,
  retryLimit: number
): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await env.MAIL_KV.list({
      prefix: PROCESSING_PREFIX,
      cursor
    });

    for (const key of page.keys) {
      const processingId = key.name.slice(PROCESSING_PREFIX.length);
      const state = await loadProcessingState(env.MAIL_KV, processingId);

      await compensateProcessingState(env, processingId, state, now, retryLimit);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function compensateProcessingState(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  await compensateTelegramNotification(env, processingId, state, now, retryLimit);
  await compensateFallbackAlert(env, processingId, state, now, retryLimit);
  await compensateCriticalBackupAlert(env, processingId, state, now, retryLimit);
}

async function compensateTelegramNotification(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  if (state.backup_done !== true || state.telegram_done !== false) {
    return;
  }

  const attempts = state.telegram_attempts ?? 0;

  if (attempts >= retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "telegram",
      reason: state.telegram_error,
      retryLimit
    });
    return;
  }

  if (!isRetryDue(state.telegram_next_retry_at, now)) {
    return;
  }

  if (
    state.telegram_stage === "message_sent_mapping_failed" &&
    typeof state.telegram_message_id === "number" &&
    state.telegram_email_id
  ) {
    await repairMessageMapping(env, processingId, state, now, retryLimit);
    return;
  }

  await sendReplacementNotification(env, processingId, state, now, retryLimit);
}

async function repairMessageMapping(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  const attempts = state.telegram_attempts ?? 0;

  try {
    await putMessageMapping(env.MAIL_KV, state.telegram_message_id!, {
      emailId: state.telegram_email_id!,
      chatId: getTelegramChatId(env),
      messageId: state.telegram_message_id!,
      gmailMessageId: state.gmail_message_id,
      createdAt: now.toISOString()
    });

    await mergeProcessingState(env.MAIL_KV, processingId, {
      telegram_done: true,
      telegram_done_at: now.toISOString(),
      telegram_error: undefined,
      telegram_email_id: state.telegram_email_id,
      telegram_message_id: state.telegram_message_id,
      telegram_stage: "done",
      telegram_attempts: attempts + 1,
      telegram_last_attempt_at: now.toISOString(),
      telegram_next_retry_at: undefined
    });
  } catch (error) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: getErrorReason(error, "message_mapping_repair_failed")
    });
  }
}

async function sendReplacementNotification(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  if (!state.telegram_email_id) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: "telegram_email_id_missing"
    });
    return;
  }

  const cached = await getEmailCacheRecord(env.MAIL_KV, state.telegram_email_id);

  if (!cached) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: "email_cache_missing"
    });
    return;
  }

  if (!cached.summaryText) {
    await notifyEmailSummary({
      env,
      processingId,
      state,
      retryLimit,
      parsed: {
        ...buildParsedFromState(state),
        ...cached.metadata,
        text: cached.text
      },
      cache: { emailId: state.telegram_email_id, record: cached },
      backupProvider: state.backup_provider,
      backupMessageId: state.gmail_message_id
    });
    return;
  }

  if (cached.summary) {
    Object.assign(state, buildSummaryStatePatch(cached.summary), {
      telegram_variant: cached.summary.ok ? "summary" : "summary_placeholder"
    });
  }

  const summaryRepair = await maybeRepairPlaceholderSummary(
    env,
    state,
    cached.text,
    cached.metadata.subject,
    cached.metadata.to
  );
  const text = summaryRepair.text ?? withPrivacyRouteNotice(
    cached.summaryText,
    cached.summary?.privacyDowngraded ?? state.summary_privacy_downgraded ?? false
  );
  const variant = summaryRepair.text ? "summary" : state.telegram_variant;

  try {
    if (summaryRepair.edited) {
      await mergeSuccessfulTelegramState(env, processingId, state, {
        now,
        attempts: (state.telegram_attempts ?? 0) + 1,
        messageId: state.telegram_message_id,
        variant: "summary",
        summaryDone: true
      });
      return;
    }

    const telegram = await sendTelegramMessage(env, text, {
      replyMarkup: buildSummaryKeyboard({
        showDeleteWithGmail: Boolean(state.gmail_message_id)
      })
    });
    await putMessageMapping(env.MAIL_KV, telegram.messageId, {
      emailId: state.telegram_email_id,
      chatId: getTelegramChatId(env),
      messageId: telegram.messageId,
      gmailMessageId: state.gmail_message_id,
      createdAt: now.toISOString()
    });
    await mergeSuccessfulTelegramState(env, processingId, state, {
      now,
      attempts: (state.telegram_attempts ?? 0) + 1,
      messageId: telegram.messageId,
      variant,
      summaryDone: summaryRepair.text ? true : undefined
    });
  } catch (error) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: getErrorReason(error, "send_message_failed")
    });
  }
}

async function maybeRepairPlaceholderSummary(
  env: Env,
  state: ProcessingState,
  cachedText: string,
  subject: string,
  to: string[]
): Promise<{ text?: string; edited: boolean }> {
  if (
    state.telegram_variant !== "summary_placeholder" ||
    state.summary_done === true ||
    typeof state.telegram_message_id !== "number"
  ) {
    return { edited: false };
  }

  const summary = await generateEmailSummary(env, {
    to: to.join(", "),
    text: buildSummaryInputText({
      parse_done: true,
      from: "",
      to,
      subject,
      text: cachedText,
      html: "",
      headers: []
    }),
    subject
  });

  if (!summary.ok) {
    return { edited: false };
  }

  const mapping = await getMessageMapping(env.MAIL_KV, state.telegram_message_id);

  if (!mapping) {
    return { text: withPrivacyRouteNotice(summary.summary, summary.privacyDowngraded), edited: false };
  }

  try {
    await editTelegramMessageText(env, {
      chatId: mapping.chatId,
      messageId: state.telegram_message_id,
      text: withPrivacyRouteNotice(summary.summary, summary.privacyDowngraded),
      replyMarkup: buildSummaryKeyboard({
        showDeleteWithGmail: Boolean(state.gmail_message_id)
      })
    });
    return { text: withPrivacyRouteNotice(summary.summary, summary.privacyDowngraded), edited: true };
  } catch {
    return { text: withPrivacyRouteNotice(summary.summary, summary.privacyDowngraded), edited: false };
  }
}

async function mergeSuccessfulTelegramState(
  env: Env,
  processingId: string,
  state: ProcessingState,
  input: {
    now: Date;
    attempts: number;
    messageId?: number;
    variant?: ProcessingState["telegram_variant"];
    summaryDone?: boolean;
  }
): Promise<void> {
  await mergeProcessingState(env.MAIL_KV, processingId, {
    telegram_done: true,
    telegram_done_at: input.now.toISOString(),
    telegram_error: undefined,
    telegram_email_id: state.telegram_email_id,
    telegram_message_id: input.messageId,
    telegram_variant: input.variant,
    telegram_stage: "done",
    telegram_attempts: input.attempts,
    telegram_last_attempt_at: input.now.toISOString(),
    telegram_next_retry_at: undefined,
    summary_done: input.summaryDone ?? state.summary_done,
    summary_done_at: input.summaryDone ? input.now.toISOString() : state.summary_done_at,
    summary_error: input.summaryDone ? undefined : state.summary_error,
    summary_error_detail: input.summaryDone ? undefined : state.summary_error_detail,
    summary_privacy_downgraded: state.summary_privacy_downgraded,
    summary_fallback_model_used: input.summaryDone
      ? undefined
      : state.summary_fallback_model_used,
    summary_model: input.summaryDone ? undefined : state.summary_model
  });
}

async function recordTelegramFailure(
  env: Env,
  processingId: string,
  state: ProcessingState,
  input: { now: Date; retryLimit: number; reason: string }
): Promise<void> {
  const nextAttempts = (state.telegram_attempts ?? 0) + 1;

  await mergeProcessingState(env.MAIL_KV, processingId, {
    telegram_done: false,
    telegram_stage: state.telegram_stage ?? "send_message_failed",
    telegram_error: sanitizeAlertReason(input.reason),
    telegram_attempts: nextAttempts,
    telegram_last_attempt_at: input.now.toISOString(),
    telegram_next_retry_at:
      nextAttempts < input.retryLimit
        ? new Date(input.now.getTime() + RETRY_DELAY_MS).toISOString()
        : undefined
  });

  if (nextAttempts >= input.retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "telegram",
      reason: input.reason,
      retryLimit: input.retryLimit
    });
  }
}

async function compensateFallbackAlert(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  if (state.fallback_alert_done === true) {
    return;
  }

  const attempts = state.fallback_alert_attempts ?? 0;

  if (attempts >= retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "fallback_alert",
      reason: state.fallback_alert_error,
      retryLimit
    });
    return;
  }

  if (state.fallback_alert_done !== false) {
    return;
  }

  const provider = state.backup_provider === "resend" ? "resend" : "cloudflare_email";
  const alert = await sendFallbackBackupAlert(env, buildParsedFromState(state), {
    provider,
    gmailReason: extractChainReason(state, "gmail_failed") ?? "unknown_error"
  });
  const nextAttempts = attempts + 1;

  await mergeProcessingState(env.MAIL_KV, processingId, {
    fallback_alert_done: alert.ok,
    fallback_alert_done_at: alert.ok ? now.toISOString() : undefined,
    fallback_alert_attempts: nextAttempts,
    fallback_alert_error: alert.ok ? undefined : alert.reason
  });

  if (!alert.ok && nextAttempts >= retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "fallback_alert",
      reason: alert.reason,
      retryLimit
    });
  }
}

async function compensateCriticalBackupAlert(
  env: Env,
  processingId: string,
  state: ProcessingState,
  now: Date,
  retryLimit: number
): Promise<void> {
  if (state.critical_backup_alert_done === true) {
    return;
  }

  const attempts = state.critical_backup_alert_attempts ?? 0;

  if (attempts >= retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "critical_backup_alert",
      reason: state.critical_backup_alert_error,
      retryLimit
    });
    return;
  }

  if (state.critical_backup_alert_done !== false) {
    return;
  }

  const backupErrorChain = state.backup_error_chain ?? state.backup_error ?? "";
  const alert = await sendCriticalBackupAlert(env, buildParsedFromState(state), {
    gmailReason: extractChainReason(state, "gmail_failed") ?? "unknown_error",
    cloudflareReason:
      extractChainReason(state, "cloudflare_email_failed") ?? "unknown_error",
    resendReason: extractChainReason(state, "resend_failed") ?? "unknown_error",
    backupErrorChain
  });
  const nextAttempts = attempts + 1;

  await mergeProcessingState(env.MAIL_KV, processingId, {
    critical_backup_alert_done: alert.ok,
    critical_backup_alert_done_at: alert.ok ? now.toISOString() : undefined,
    critical_backup_alert_attempts: nextAttempts,
    critical_backup_alert_error: alert.ok ? undefined : alert.reason
  });

  if (!alert.ok && nextAttempts >= retryLimit) {
    await sendFinalFailureAlert(env, {
      processingId,
      category: "critical_backup_alert",
      reason: alert.reason,
      retryLimit
    });
  }
}

async function sendFinalFailureAlert(
  env: Env,
  input: {
    processingId: string;
    category: string;
    reason: unknown;
    retryLimit: number;
  }
): Promise<void> {
  const dedupeKey = `telegram-compensation:final:${input.processingId}:${input.category}`;

  if ((await env.MAIL_KV.get(dedupeKey)) !== null) {
    return;
  }

  try {
    await sendTelegramMessage(
      env,
      [
        "Telegram 补偿最终失败",
        "",
        `类别: ${sanitizeAlertReason(input.category)}`,
        `处理ID: ${sanitizeAlertReason(input.processingId)}`,
        `原因: ${sanitizeAlertReason(input.reason)}`,
        `上限: ${input.retryLimit}`
      ].join("\n")
    );
    await env.MAIL_KV.put(dedupeKey, "1", {
      expirationTtl: FINAL_ALERT_TTL_SECONDS
    });
  } catch (error) {
    logError("telegram_compensation_final_alert_failed", error, {
      processingId: input.processingId,
      category: input.category
    });
  }
}

function buildParsedFromState(state: ProcessingState): ParsedEmailForProcessing {
  return {
    parse_done: state.parse_done ?? true,
    from: state.from ?? "",
    to: state.to ?? [],
    subject: state.subject ?? "",
    text: "",
    html: "",
    headers: [],
    messageId: state.message_id,
    rawSize: state.rawSize,
    maxParseBytes: state.maxParseBytes,
    parse_skipped_reason: state.parse_skipped_reason
  };
}

function extractChainReason(
  state: ProcessingState,
  prefix: string
): string | undefined {
  const chain = state.backup_error_chain ?? state.backup_error;

  if (!chain) {
    return undefined;
  }

  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = chain.match(new RegExp(`${escaped}:([^;]+)`));

  return match?.[1];
}

function isRetryDue(nextRetryAt: string | undefined, now: Date): boolean {
  if (!nextRetryAt) {
    return true;
  }

  const nextRetryMs = Date.parse(nextRetryAt);

  if (!Number.isFinite(nextRetryMs)) {
    return true;
  }

  return nextRetryMs <= now.getTime();
}

function getRetryLimit(env: Env): number {
  const configured = Number(env.TELEGRAM_RETRY_LIMIT);

  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_RETRY_LIMIT;
}

function getErrorReason(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "reason" in error) {
    return sanitizeAlertReason((error as { reason?: unknown }).reason);
  }

  return fallback;
}
