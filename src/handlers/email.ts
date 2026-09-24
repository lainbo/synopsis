import { buildProcessingId } from "../services/processing-id";
import { backupEmail } from "../services/backup-orchestrator";
import { notifyEmailSummary } from "../services/notification-orchestrator";
import {
  createEmailCacheEntry,
  type CreateEmailCacheEntryResult
} from "../services/email-cache";
import {
  buildParseStatePatch,
  loadProcessingState,
  mergeProcessingState
} from "../services/processing-state";
import {
  buildDegradedParsedEmail,
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
    const rawReadFailure =
      error instanceof Error ? error : new Error(String(error));
    throw rawReadFailure;
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
      parse_done: false,
      parse_skipped_reason: "skipped_large_email",
      from: message.from,
      to: [message.to],
      subject: message.headers.get("subject") || "(无法解析主题)",
      text: "",
      html: "",
      date: message.headers.get("date") || undefined,
      messageId: message.headers.get("message-id") || undefined,
      headers: Array.from(message.headers.entries()).map(([key, value]) => ({
        key: key.toLowerCase(),
        value
      })),
      rawSize: raw.rawSize,
      maxParseBytes
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
      parsed = buildDegradedParsedEmail(message, error, raw.rawSize);
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
    rawSize: parsed.rawSize ?? raw.rawSize,
    maxParseBytes: parsed.maxParseBytes ?? maxParseBytes
  };

  state = await mergeProcessingState(env.MAIL_KV, processingId, {
    ...buildParseStatePatch(parsedForState),
    // 初始化 telegram_done=false，让实例在通知完成前被回收时 Cron 补偿仍能接手；
    // next_retry_at 留出一个重试周期，避免与本次 waitUntil 内的即时通知竞争。
    ...(state.telegram_done !== true
      ? {
          telegram_done: false as const,
          telegram_email_id: state.telegram_email_id ?? crypto.randomUUID(),
          telegram_next_retry_at: new Date(
            Date.now() + TELEGRAM_COMPENSATION_GRACE_MS
          ).toISOString()
        }
      : {}),
    incrementAttempt: true
  });

  const backupResult = await backupEmail({
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
    cache = await createEmailCacheEntry(env.MAIL_KV, {
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
      cache,
      backupProvider: backupResult.provider,
      backupMessageId: backupResult.skipped ? state.gmail_message_id : backupResult.messageId
    }).catch((error) => {
      logError("email_notification_failed", error, { processingId });
    })
  );
}

export const DEFAULT_MAX_PARSE_BYTES = 10485760;

// 与 telegram-compensation 的 RETRY_DELAY_MS 对齐：给 waitUntil 内的即时通知留一个重试周期。
const TELEGRAM_COMPENSATION_GRACE_MS = 5 * 60 * 1000;

export function getMaxParseBytes(env: Env): number {
  const configured = Number(env.MAX_PARSE_BYTES);

  if (Number.isFinite(configured) && Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_MAX_PARSE_BYTES;
}
