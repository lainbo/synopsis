import type { ParsedEmailForProcessing } from "./mime-parser";
import { putKvValue } from "./kv-write";

export const PROCESSING_STATE_TTL_SECONDS = 86400;

export interface ProcessingState {
  backup_done?: boolean;
  backup_provider?: "gmail" | "cloudflare_email" | "resend";
  backup_done_at?: string;
  gmail_message_id?: string;
  fallback_message_id?: string;
  backup_error?: string;
  backup_error_chain?: string;
  fallback_alert_done?: boolean;
  fallback_alert_done_at?: string;
  fallback_alert_attempts?: number;
  fallback_alert_error?: string;
  critical_backup_alert_done?: boolean;
  critical_backup_alert_done_at?: string;
  critical_backup_alert_attempts?: number;
  critical_backup_alert_error?: string;
  summary_done?: boolean;
  summary_done_at?: string;
  summary_error?: string;
  summary_error_detail?: string;
  summary_privacy_downgraded?: boolean;
  summary_fallback_model_used?: boolean;
  summary_model?: string;
  telegram_done?: boolean;
  telegram_done_at?: string;
  telegram_error?: string;
  telegram_email_id?: string;
  telegram_message_id?: number;
  telegram_variant?: "summary" | "summary_placeholder";
  telegram_attempts?: number;
  telegram_last_attempt_at?: string;
  telegram_next_retry_at?: string;
  telegram_stage?:
    | "email_cache_failed"
    | "send_message_failed"
    | "message_sent_mapping_failed"
    | "done";
  parse_done?: boolean;
  last_error?: string;
  attempt_count?: number;
  created_at?: string;
  updated_at?: string;
  message_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  rawSize?: number;
  maxParseBytes?: number;
  parse_skipped_reason?: string;
}

type ProcessingStatePatch = Partial<ProcessingState> & {
  incrementAttempt?: boolean;
};

export async function loadProcessingState(
  kv: KVNamespace,
  processingId: string
): Promise<ProcessingState> {
  const key = `processing:${processingId}`;
  const existing = await kv.get(key);

  if (!existing) {
    return {};
  }

  try {
    return JSON.parse(existing) as ProcessingState;
  } catch {
    return {};
  }
}

export async function mergeProcessingState(
  kv: KVNamespace,
  processingId: string,
  patch: ProcessingStatePatch
): Promise<ProcessingState> {
  const key = `processing:${processingId}`;
  const existing = await loadProcessingState(kv, processingId);
  const now = new Date().toISOString();
  const { incrementAttempt, ...statePatch } = patch;
  const next: ProcessingState = {
    ...existing,
    ...statePatch,
    created_at: existing.created_at ?? now,
    updated_at: now,
    attempt_count:
      incrementAttempt === true
        ? (existing.attempt_count ?? 0) + 1
        : existing.attempt_count
  };

  await putKvValue(kv, key, JSON.stringify(next), {
    expirationTtl: PROCESSING_STATE_TTL_SECONDS
  });

  return next;
}

export function buildParseStatePatch(
  parsed: ParsedEmailForProcessing
): ProcessingState {
  return {
    parse_done: parsed.parse_done,
    last_error: parsed.last_error,
    message_id: parsed.messageId,
    from: parsed.from,
    to: parsed.to,
    subject: parsed.subject,
    rawSize: parsed.rawSize,
    maxParseBytes: parsed.maxParseBytes,
    parse_skipped_reason: parsed.parse_skipped_reason
  };
}
