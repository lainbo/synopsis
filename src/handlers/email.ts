import { buildProcessingId, isProcessingId } from "../services/processing-id";
import { backupEmail, backupFallbackLoopback } from "../services/backup-orchestrator";
import { notifyEmailSummary } from "../services/notification-orchestrator";
import { getMaxParseBytes, TELEGRAM_RETRY_DELAY_MS } from "../services/config";
import {
  getOrCreateEmailCacheEntry,
  type CreateEmailCacheEntryResult
} from "../services/email-cache";
import {
  buildParseStatePatch,
  loadProcessingState,
  mergeProcessingState
} from "../services/processing-state";
import {
  buildDegradedParsedEmail,
  buildHeaderOnlyParsedEmail,
  type ParsedEmailForProcessing,
  parseMimeEmail
} from "../services/mime-parser";
import { readRawEmail } from "../services/raw-email";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  let raw;

  try {
    raw = await readRawEmail(message);
  } catch (error) {
    logError("raw_read_failed", error);
    throw error;
  }

  const processingId = await buildProcessingId(message, raw.bytes);
  let state = await loadProcessingState(env.MAIL_KV, processingId);
  const maxParseBytes = getMaxParseBytes(env);

  logInfo("processing_state_loaded", {
    processingId,
    backup_done: state.backup_done === true,
    summary_done: state.summary_done === true,
    telegram_done: state.telegram_done === true,
    parse_done: state.parse_done === true
  });

  if (state.parse_done === true) {
    logInfo("parse_already_done", { processingId });
  }

  let parsed: ParsedEmailForProcessing;

  if (raw.rawSize > maxParseBytes) {
    parsed = {
      ...buildHeaderOnlyParsedEmail(message),
      parse_skipped_reason: "skipped_large_email"
    };
    logInfo("email_parse_skipped", {
      processingId,
      parse_skipped_reason: "skipped_large_email",
      rawSize: raw.rawSize,
      maxParseBytes
    });
  } else {
    try {
      parsed = await parseMimeEmail(raw.bytes);
    } catch (error) {
      parsed = buildDegradedParsedEmail(message, error);
      logError("email_parse_failed", error, {
        processingId,
        rawSize: raw.rawSize
      });
    }
  }

  logInfo("email_received", {
    processingId,
    rawSize: raw.rawSize,
    parse_done: parsed.parse_done
  });

  const parsedForState: ParsedEmailForProcessing = {
    ...parsed,
    to: [message.to],
    rawSize: raw.rawSize,
    maxParseBytes
  };

  if (isFallbackLoopback(message, env)) {
    logInfo("fallback_loopback_detected", { processingId });
    await backupFallbackLoopback({
      env,
      processingId,
      rawBytes: raw.bytes,
      parsed: parsedForState
    });
    return;
  }

  state = await mergeProcessingState(env.MAIL_KV, processingId, {
    ...buildParseStatePatch(parsedForState),
    // 初始化 telegram_done=false，让实例在通知完成前被回收时 Cron 补偿仍能接手；
    // next_retry_at 留出一个重试周期，避免与本次 waitUntil 内的即时通知竞争。
    ...(state.telegram_done !== true
      ? {
          telegram_done: false as const,
          telegram_email_id: state.telegram_email_id ?? crypto.randomUUID(),
          telegram_next_retry_at: new Date(
            Date.now() + TELEGRAM_RETRY_DELAY_MS
          ).toISOString()
        }
      : {}),
    incrementAttempt: true
  });

  await backupEmail({
    env,
    processingId,
    rawBytes: raw.bytes,
    parsed: parsedForState,
    state
  });

  if (state.telegram_done === true) {
    return;
  }

  let cache: CreateEmailCacheEntryResult | undefined;
  try {
    cache = await getOrCreateEmailCacheEntry(env.MAIL_KV, {
      emailId: state.telegram_email_id!,
      parsed: parsedForState,
      summaryText: ""
    });
  } catch (error) {
    logError("email_cache_prepare_failed", error, { processingId });
  }

  ctx.waitUntil(
    notifyEmailSummary({
      env,
      processingId,
      parsed: parsedForState,
      state,
      cache
    }).catch((error) => {
      logError("email_notification_failed", error, { processingId });
    })
  );
}

// 本项目的兜底邮件都带 X-Processing-Id；收件地址等于 BACKUP_EMAIL_TO 也说明兜底地址路由回了本 Worker。
function isFallbackLoopback(message: ForwardableEmailMessage, env: Env): boolean {
  return (
    isProcessingId(message.headers.get("x-processing-id")) ||
    message.to.trim().toLowerCase() === env.BACKUP_EMAIL_TO?.trim().toLowerCase()
  );
}
