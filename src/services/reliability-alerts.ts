import { GmailAuthError } from "./gmail-auth";
import { GmailBackupError } from "./gmail-backup";
import type { ParsedEmailForProcessing } from "./mime-parser";
import { sendTelegramMessage, TelegramError } from "./telegram";
import type { Env } from "../types";

export const GMAIL_AUTH_ALERT_KEY = "gmail:auth_alert";

export type ReliabilityAlertResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: string };

export type GmailAuthExpiryReason =
  | "invalid_grant"
  | "token_expired_or_revoked"
  | "gmail_401_after_refresh";

interface GmailAuthAlertState {
  done?: boolean;
  reason?: GmailAuthExpiryReason;
  first_seen_at?: string;
  last_seen_at?: string;
  affected_count?: number;
  attempts?: number;
  last_attempt_at?: string;
  next_retry_at?: string;
  error?: string;
}

export function sanitizeAlertReason(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown_error";
  }

  const reason = value.trim();

  if (/^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/.test(reason)) {
    return reason;
  }

  return "unknown_error";
}

export async function sendFallbackBackupAlert(
  env: Env,
  parsed: ParsedEmailForProcessing,
  details: {
    provider: "cloudflare_email" | "resend";
    gmailReason: string;
  }
): Promise<ReliabilityAlertResult> {
  const text = [
    "Gmail 备份异常（已兜底）",
    "",
    `发件人: ${parsed.from || "(未知发件人)"}`,
    `收件人: ${formatRecipients(parsed.to)}`,
    `主题: ${parsed.subject || "(无主题)"}`,
    `兜底: ${formatFallbackProvider(details.provider)}`,
    `原因: ${sanitizeAlertReason(details.gmailReason)}`
  ].join("\n");

  return sendAlertText(env, text);
}

export async function sendCriticalBackupAlert(
  env: Env,
  parsed: ParsedEmailForProcessing,
  details: {
    gmailReason: string;
    cloudflareReason: string;
    resendReason: string;
    backupErrorChain: string;
  },
  options: { timeoutMs?: number } = { timeoutMs: 2500 }
): Promise<ReliabilityAlertResult> {
  const text = [
    "邮件备份彻底失败，Cloudflare 将重试投递",
    "",
    `发件人: ${parsed.from || "(未知发件人)"}`,
    `收件人: ${formatRecipients(parsed.to)}`,
    `主题: ${parsed.subject || "(无主题)"}`,
    "失败链路: Gmail API / Cloudflare Email Sending / Resend",
    "原因: all_backup_failed",
    `Gmail: ${sanitizeAlertReason(details.gmailReason)}`,
    `Cloudflare Email Sending: ${sanitizeAlertReason(details.cloudflareReason)}`,
    `Resend: ${sanitizeAlertReason(details.resendReason)}`,
    "请检查 Gmail 授权、Cloudflare Email Sending、Resend 配置。"
  ].join("\n");

  return sendAlertTextWithTimeout(env, text, options.timeoutMs ?? 2500);
}

export async function sendAiSummaryFallbackModelAlert(
  env: Env,
  details: {
    primaryModel: string;
    fallbackModel: string;
    reason: string;
  }
): Promise<ReliabilityAlertResult> {
  const text = [
    "AI 摘要已切换备用模型",
    "",
    `主模型: ${sanitizeAlertReason(details.primaryModel)}`,
    `备用模型: ${sanitizeAlertReason(details.fallbackModel)}`,
    `原因: ${sanitizeAlertReason(details.reason)}`,
    "原件备份不受影响。"
  ].join("\n");

  return sendAlertText(env, text);
}

export function classifyGmailAuthExpiryReason(
  error: unknown
): GmailAuthExpiryReason | null {
  if (error instanceof GmailAuthError) {
    if (error.reason === "invalid_grant") {
      return "invalid_grant";
    }

    if (isTokenExpiredOrRevoked(error.reason)) {
      return "token_expired_or_revoked";
    }
  }

  if (
    error instanceof GmailBackupError &&
    error.reason === "gmail_401_after_refresh"
  ) {
    return "gmail_401_after_refresh";
  }

  return null;
}

export async function recordGmailAuthAlert(
  env: Env,
  reason: GmailAuthExpiryReason
): Promise<void> {
  const existing = await loadGmailAuthAlertState(env.MAIL_KV);
  const now = new Date().toISOString();
  const base: GmailAuthAlertState = {
    ...existing,
    reason,
    first_seen_at: existing.first_seen_at ?? now,
    last_seen_at: now,
    affected_count: (existing.affected_count ?? 0) + 1
  };

  if (existing.done === true) {
    await putGmailAuthAlertState(env.MAIL_KV, {
      ...base,
      done: true
    });
    return;
  }

  const result = await sendAlertText(
    env,
    [
      "Gmail 授权失效",
      "",
      `原因: ${reason}`,
      "请重新生成 Gmail refresh_token 并更新 Cloudflare Secret。"
    ].join("\n")
  );

  await putGmailAuthAlertState(env.MAIL_KV, {
    ...base,
    done: result.ok,
    error: result.ok ? undefined : result.reason
  });
}

export async function clearGmailAuthAlert(kv: KVNamespace): Promise<void> {
  const maybeDelete = (kv as { delete?: (key: string) => Promise<void> }).delete;

  if (typeof maybeDelete === "function") {
    await maybeDelete.call(kv, GMAIL_AUTH_ALERT_KEY);
  }
}

export async function retryGmailAuthAlert(
  env: Env,
  options: { now?: Date; retryLimit?: number } = {}
): Promise<void> {
  const state = await loadGmailAuthAlertState(env.MAIL_KV);

  if (state.done === true || !state.reason) {
    return;
  }

  const now = options.now ?? new Date();
  const retryLimit = options.retryLimit ?? 3;
  const attempts = state.attempts ?? 0;

  if (attempts >= retryLimit || !isRetryDue(state.next_retry_at, now)) {
    return;
  }

  const result = await sendAlertText(
    env,
    [
      "Gmail 授权失效",
      "",
      `原因: ${state.reason}`,
      "请重新生成 Gmail refresh_token 并更新 Cloudflare Secret。"
    ].join("\n")
  );
  const nextAttempts = attempts + 1;

  await putGmailAuthAlertState(env.MAIL_KV, {
    ...state,
    done: result.ok,
    attempts: nextAttempts,
    last_attempt_at: now.toISOString(),
    next_retry_at: result.ok
      ? undefined
      : nextAttempts < retryLimit
        ? new Date(now.getTime() + 300000).toISOString()
        : undefined,
    error: result.ok ? undefined : result.reason
  });
}

async function sendAlertText(
  env: Env,
  text: string
): Promise<ReliabilityAlertResult> {
  try {
    const result = await sendTelegramMessage(env, text);

    return { ok: true, messageId: result.messageId };
  } catch (error) {
    return { ok: false, reason: getAlertErrorReason(error) };
  }
}

async function sendAlertTextWithTimeout(
  env: Env,
  text: string,
  timeoutMs: number
): Promise<ReliabilityAlertResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const sendPromise = sendAlertText(env, text);
  const timeoutPromise = new Promise<ReliabilityAlertResult>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ ok: false, reason: "telegram_timeout" });
    }, timeoutMs);
  });

  const result = await Promise.race([sendPromise, timeoutPromise]);

  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }

  return result;
}

function getAlertErrorReason(error: unknown): string {
  if (error instanceof TelegramError) {
    return sanitizeAlertReason(error.reason);
  }

  if (error && typeof error === "object" && "reason" in error) {
    return sanitizeAlertReason((error as { reason?: unknown }).reason);
  }

  return "unknown_error";
}

function isTokenExpiredOrRevoked(reason: string): boolean {
  return (
    reason === "token_expired_or_revoked" ||
    reason === "expired_or_revoked" ||
    reason === "Token_expired_or_revoked"
  );
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

function formatRecipients(recipients: string[]): string {
  return recipients.length > 0 ? recipients.join(", ") : "(未知收件人)";
}

function formatFallbackProvider(provider: "cloudflare_email" | "resend"): string {
  return provider === "cloudflare_email" ? "Cloudflare Email Sending" : "Resend";
}

async function loadGmailAuthAlertState(
  kv: KVNamespace
): Promise<GmailAuthAlertState> {
  const stored = await kv.get(GMAIL_AUTH_ALERT_KEY);

  if (!stored) {
    return {};
  }

  try {
    return JSON.parse(stored) as GmailAuthAlertState;
  } catch {
    return {};
  }
}

async function putGmailAuthAlertState(
  kv: KVNamespace,
  state: GmailAuthAlertState
): Promise<void> {
  await kv.put(GMAIL_AUTH_ALERT_KEY, JSON.stringify(state));
}
