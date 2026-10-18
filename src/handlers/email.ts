import { buildProcessingId, isProcessingId } from "../services/processing-id";
import { backupEmail, backupFallbackLoopback } from "../services/backup-orchestrator";
import {
  buildTelegramPendingPatch,
  startEmailNotification
} from "../services/notification-orchestrator";
import { getMaxParseBytes } from "../services/config";
import {
  buildParseStatePatch,
  loadProcessingState,
  mergeProcessingState
} from "../services/processing-state";
import { headersToEntries, parseEmailForProcessing } from "../services/mime-parser";
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

  const parsed = await parseEmailForProcessing({
    processingId,
    envelope: {
      from: message.from,
      to: message.to,
      headers: headersToEntries(message.headers)
    },
    rawSize: raw.rawSize,
    maxParseBytes: getMaxParseBytes(env),
    readRaw: async () => raw.bytes
  });

  if (isFallbackLoopback(message, env)) {
    logInfo("fallback_loopback_detected", { processingId });
    await backupFallbackLoopback({
      env,
      processingId,
      rawBytes: raw.bytes,
      parsed
    });
    return;
  }

  state = await mergeProcessingState(env.MAIL_KV, processingId, {
    ...buildParseStatePatch(parsed),
    ...buildTelegramPendingPatch(state),
    incrementAttempt: true
  });

  await backupEmail({
    env,
    processingId,
    rawBytes: raw.bytes,
    parsed,
    state
  });

  await startEmailNotification({ env, ctx, processingId, parsed, state });
}

// 本项目的兜底邮件都带 X-Processing-Id；收件地址等于 BACKUP_EMAIL_TO 也说明兜底地址路由回了本 Worker。
function isFallbackLoopback(message: ForwardableEmailMessage, env: Env): boolean {
  return (
    isProcessingId(message.headers.get("x-processing-id")) ||
    message.to.trim().toLowerCase() === env.BACKUP_EMAIL_TO?.trim().toLowerCase()
  );
}
