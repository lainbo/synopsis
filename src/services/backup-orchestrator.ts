import { insertGmailMessage, GmailBackupError } from "./gmail-backup";
import { GmailAuthError } from "./gmail-auth";
import {
  sendCloudflareFallback,
  CloudflareEmailFallbackError
} from "./cloudflare-email-fallback";
import { sendResendFallback, ResendFallbackError } from "./resend-fallback";
import { mergeProcessingState, type ProcessingState } from "./processing-state";
import {
  classifyGmailAuthExpiryReason,
  clearGmailAuthAlert,
  recordGmailAuthAlert,
  sendCriticalBackupAlert,
  sendFallbackBackupAlert,
  type GmailAuthExpiryReason
} from "./reliability-alerts";
import type { ParsedEmailForProcessing } from "./mime-parser";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

export interface BackupEmailParams {
  env: Env;
  processingId: string;
  rawBytes: Uint8Array;
  parsed: ParsedEmailForProcessing;
  state: ProcessingState;
}

export type BackupEmailResult =
  | {
      provider: "gmail" | "cloudflare_email" | "resend";
      skipped: false;
      messageId?: string;
      backupErrorChain?: string;
    }
  | { provider: "gmail" | "cloudflare_email" | "resend"; skipped: true };

export async function backupEmail({
  env,
  processingId,
  rawBytes,
  parsed,
  state
}: BackupEmailParams): Promise<BackupEmailResult> {
  if (state.backup_done === true) {
    const provider = state.backup_provider ?? "gmail";
    if (
      provider !== "gmail" &&
      state.fallback_alert_done !== true &&
      (state.fallback_alert_attempts ?? 0) < 3
    ) {
      await recordFallbackAlertAttempt({
        env,
        processingId,
        parsed,
        provider,
        gmailReason: extractGmailReasonFromChain(
          state.backup_error_chain ?? state.backup_error
        ),
        state
      }).catch((error) => {
        logError("fallback_alert_retry_failed", error, {
          processingId,
          backup_provider: provider
        });
      });
    }

    logInfo("backup_already_done", { processingId, backup_provider: provider });
    return { provider, skipped: true };
  }

  const providers = [
    {
      provider: "gmail" as const,
      send: async () => (await insertGmailMessage(env, rawBytes)).id
    },
    {
      provider: "cloudflare_email" as const,
      send: async () => (await sendCloudflareFallback(env, processingId, parsed, rawBytes)).messageId
    },
    {
      provider: "resend" as const,
      send: async () => (await sendResendFallback(env, processingId, parsed, rawBytes)).id
    }
  ];
  const reasons: Partial<Record<BackupEmailResult["provider"], string>> = {};
  const errors: string[] = [];
  let authReason: GmailAuthExpiryReason | null = null;

  for (const { provider, send } of providers) {
    let messageId: string | undefined;

    try {
      messageId = await send();
    } catch (error) {
      const reason = getBackupFailureReason(error);
      reasons[provider] = reason;
      errors.push(`${provider}_failed:${reason}`);
      if (provider === "gmail") {
        authReason = classifyGmailAuthExpiryReason(error);
      }
      logError(`${provider}_backup_failed`, error, {
        processingId,
        backup_provider: provider,
        reason
      });
      continue;
    }

    const backupErrorChain = errors.length > 0 ? errors.join(";") : undefined;
    // 供应商已确认成功，状态保存失败不能再发送另一份备份。
    Object.assign(state, {
      backup_done: true,
      backup_provider: provider,
      backup_done_at: new Date().toISOString(),
      gmail_message_id: provider === "gmail" ? messageId : undefined,
      fallback_message_id: provider === "gmail" ? undefined : messageId,
      backup_error: backupErrorChain,
      backup_error_chain: backupErrorChain,
      ...(provider !== "gmail" ? { fallback_alert_done: false } : {})
    });
    await mergeProcessingState(env.MAIL_KV, processingId, state).catch((error) => {
      logError("backup_state_save_failed", error, { processingId, backup_provider: provider });
    });

    if (provider === "gmail") {
      await clearGmailAuthAlert(env.MAIL_KV).catch((error) => {
        logError("gmail_auth_alert_clear_failed", error, { processingId });
      });
    } else {
      await recordAuthAlert(authReason);
      await recordFallbackAlertAttempt({
        env,
        processingId,
        parsed,
        provider,
        gmailReason: reasons.gmail ?? "unknown_error",
        state
      }).catch((error) => {
        logError("fallback_alert_failed", error, { processingId, backup_provider: provider });
      });
    }

    logInfo(`${provider}_backup_done`, {
      processingId,
      backup_provider: provider,
      gmail_message_id: state.gmail_message_id,
      fallback_message_id: state.fallback_message_id
    });
    return { provider, skipped: false, messageId, backupErrorChain };
  }

  const backupErrorChain = errors.join(";");
  const failureState: ProcessingState = {
    backup_done: false,
    backup_error: backupErrorChain,
    backup_error_chain: backupErrorChain,
    critical_backup_alert_done: state.critical_backup_alert_done ?? false
  };
  await mergeProcessingState(env.MAIL_KV, processingId, failureState).catch((error) => {
    logError("backup_state_save_failed", error, { processingId });
  });
  await recordAuthAlert(authReason);

  if (
    state.critical_backup_alert_done !== true &&
    (state.critical_backup_alert_attempts ?? 0) < 3
  ) {
    const alert = await sendCriticalBackupAlert(env, parsed, {
      gmailReason: reasons.gmail ?? "unknown_error",
      cloudflareReason: reasons.cloudflare_email ?? "unknown_error",
      resendReason: reasons.resend ?? "unknown_error",
      backupErrorChain
    }, { timeoutMs: 2500 });
    Object.assign(failureState, {
      critical_backup_alert_done: alert.ok,
      critical_backup_alert_done_at: alert.ok ? new Date().toISOString() : undefined,
      critical_backup_alert_attempts: (state.critical_backup_alert_attempts ?? 0) + 1,
      critical_backup_alert_error: alert.ok ? undefined : alert.reason
    });
    await mergeProcessingState(env.MAIL_KV, processingId, failureState).catch((error) => {
      logError("backup_state_save_failed", error, { processingId });
    });
  }

  throw new Error(
    `backup_failed_all_providers:gmail=${reasons.gmail};cloudflare_email=${reasons.cloudflare_email};resend=${reasons.resend}`
  );

  async function recordAuthAlert(reason: GmailAuthExpiryReason | null): Promise<void> {
    if (!reason) {
      return;
    }
    await recordGmailAuthAlert(env, reason).catch((error) => {
      logError("gmail_auth_alert_failed", error, { processingId, reason });
    });
  }
}

function getBackupFailureReason(error: unknown): string {
  if (error instanceof GmailBackupError || error instanceof GmailAuthError) {
    return error.reason;
  }

  if (error instanceof CloudflareEmailFallbackError) {
    return error.reason;
  }

  if (error instanceof ResendFallbackError) {
    return error.reason;
  }

  return "unknown_error";
}

async function recordFallbackAlertAttempt(params: {
  env: Env;
  processingId: string;
  parsed: ParsedEmailForProcessing;
  provider: "cloudflare_email" | "resend";
  gmailReason: string;
  state: ProcessingState;
}): Promise<void> {
  if (
    params.state.fallback_alert_done === true ||
    (params.state.fallback_alert_attempts ?? 0) >= 3
  ) {
    return;
  }

  const previousAttempts = params.state.fallback_alert_attempts ?? 0;
  const alert = await sendFallbackBackupAlert(params.env, params.parsed, {
    provider: params.provider,
    gmailReason: params.gmailReason
  });

  const patch: ProcessingState = {
    fallback_alert_done: alert.ok,
    fallback_alert_done_at: alert.ok ? new Date().toISOString() : undefined,
    fallback_alert_attempts: previousAttempts + 1,
    fallback_alert_error: alert.ok ? undefined : alert.reason
  };
  Object.assign(params.state, patch);
  await mergeProcessingState(params.env.MAIL_KV, params.processingId, patch);
}

function extractGmailReasonFromChain(value: string | undefined): string {
  if (!value) {
    return "unknown_error";
  }

  const match = value.match(/^gmail_failed:([^;]+)/);

  return match ? match[1] : "unknown_error";
}
