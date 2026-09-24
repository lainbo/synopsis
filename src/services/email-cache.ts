import { buildReadableEmailBody } from "./email-readable-text";
import type { ParsedEmailForProcessing } from "./mime-parser";
import { putKvValue } from "./kv-write";
import type { SummaryResult } from "./email-summary";

export const EMAIL_CACHE_TTL_SECONDS = 604800;

export interface EmailCacheMetadata {
  from: string;
  to: string[];
  subject: string;
  date?: string;
  messageId?: string;
}

export interface EmailCacheRecord {
  text: string;
  summaryText: string;
  summary?: SummaryResult;
  metadata: EmailCacheMetadata;
  createdAt: string;
}

export interface MessageMapping {
  emailId: string;
  chatId: string;
  messageId: number;
  gmailMessageId?: string;
  createdAt: string;
}

export interface CreateEmailCacheEntryInput {
  emailId: string;
  parsed: ParsedEmailForProcessing;
  summaryText: string;
  createdAt?: string;
}

export interface CreateEmailCacheEntryResult {
  emailId: string;
  record: EmailCacheRecord;
}

export async function createEmailCacheEntry(
  kv: KVNamespace,
  input: CreateEmailCacheEntryInput
): Promise<CreateEmailCacheEntryResult> {
  const emailId = input.emailId;
  const record: EmailCacheRecord = {
    text: buildReadableEmailBody(input.parsed),
    summaryText: input.summaryText,
    metadata: {
      from: input.parsed.from,
      to: input.parsed.to,
      subject: input.parsed.subject,
      date: input.parsed.date,
      messageId: input.parsed.messageId
    },
    createdAt: input.createdAt ?? new Date().toISOString()
  };

  await putEmailCacheRecord(kv, emailId, record);

  return { emailId, record };
}

export async function putEmailCacheRecord(
  kv: KVNamespace,
  emailId: string,
  record: EmailCacheRecord
): Promise<void> {
  await putKvValue(kv, `email:${emailId}`, JSON.stringify(record), {
    expirationTtl: EMAIL_CACHE_TTL_SECONDS
  });
}

export async function getEmailCacheRecord(
  kv: KVNamespace,
  emailId: string
): Promise<EmailCacheRecord | null> {
  const stored = await kv.get(`email:${emailId}`);

  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored) as EmailCacheRecord;
  } catch {
    return null;
  }
}

export async function deleteEmailCacheRecord(
  kv: KVNamespace,
  emailId: string
): Promise<void> {
  await kv.delete(`email:${emailId}`);
}

export async function putMessageMapping(
  kv: KVNamespace,
  messageId: number,
  mapping: MessageMapping
): Promise<void> {
  await putKvValue(kv, `msgmap:${messageId}`, JSON.stringify(mapping), {
    expirationTtl: EMAIL_CACHE_TTL_SECONDS
  });
}

export async function getMessageMapping(
  kv: KVNamespace,
  messageId: number
): Promise<MessageMapping | null> {
  const stored = await kv.get(`msgmap:${messageId}`);

  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored) as MessageMapping;
  } catch {
    return null;
  }
}

export async function deleteMessageMapping(
  kv: KVNamespace,
  messageId: number
): Promise<void> {
  await kv.delete(`msgmap:${messageId}`);
}
