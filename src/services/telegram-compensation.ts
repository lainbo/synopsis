import { getEmailCacheRecord } from "./email-cache";
import type { ParsedEmailForProcessing } from "./mime-parser";
import { notifyEmailSummary } from "./notification-orchestrator";
import {
  mergeProcessingState,
  loadProcessingState,
  type ProcessingState
} from "./processing-state";
import {
  isRetryDue,
  retryGmailAuthAlert,
  sanitizeAlertReason,
  sendCriticalBackupAlert,
  sendFallbackBackupAlert
} from "./reliability-alerts";
import { sendTelegramMessage } from "./telegram";
import { getTelegramRetryLimit, TELEGRAM_RETRY_DELAY_MS } from "./config";
import type { Env } from "../types";
import { logError } from "../utils/logging";

const PROCESSING_PREFIX = "processing:";
const FINAL_ALERT_TTL_SECONDS = 604800;

export interface RunTelegramCompensationOptions {
  now?: Date;
}

export async function runTelegramCompensation(
  env: Env,
  options: RunTelegramCompensationOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const retryLimit = getTelegramRetryLimit(env);

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
      try {
        const state = await loadProcessingState(env.MAIL_KV, processingId);
        await compensateProcessingState(env, processingId, state, now, retryLimit);
      } catch (error) {
        logError("telegram_compensation_state_failed", error, { processingId });
      }
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

  if (!state.telegram_email_id) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: "telegram_email_id_missing"
    });
    return;
  }

  const messageSent = typeof state.telegram_message_id === "number";
  const cached = messageSent ? null : await getEmailCacheRecord(env.MAIL_KV, state.telegram_email_id);

  if (!messageSent && !cached) {
    await recordTelegramFailure(env, processingId, state, {
      now,
      retryLimit,
      reason: "email_cache_missing"
    });
    return;
  }

  await notifyEmailSummary({
    env,
    processingId,
    state,
    retryLimit,
    parsed: {
      ...buildParsedFromState(state),
      ...cached?.metadata,
      text: cached?.text ?? ""
    },
    cache: cached ? { emailId: state.telegram_email_id, record: cached } : undefined
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
        ? new Date(input.now.getTime() + TELEGRAM_RETRY_DELAY_MS).toISOString()
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
  if (state.backup_done === true || state.critical_backup_alert_done === true) {
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

  const alert = await sendCriticalBackupAlert(env, buildParsedFromState(state), {
    gmailReason: extractChainReason(state, "gmail_failed") ?? "unknown_error",
    cloudflareReason:
      extractChainReason(state, "cloudflare_email_failed") ?? "unknown_error",
    resendReason: extractChainReason(state, "resend_failed") ?? "unknown_error"
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
