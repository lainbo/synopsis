import PostalMime from "postal-mime";
import type { Address, Email, Header } from "postal-mime";
import { logError, logInfo } from "../utils/logging";

export interface ParsedEmailForProcessing {
  parse_done: boolean;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  date?: string;
  messageId?: string;
  headers: Array<{ key: string; value: string }>;
  last_error?: string;
  parse_skipped_reason?: string;
  rawSize?: number;
  maxParseBytes?: number;
}

interface EmailEnvelope {
  from: string;
  to: string;
  headers: Array<{ key: string; value: string }>;
}

export async function parseEmailForProcessing({
  processingId,
  envelope,
  rawSize,
  maxParseBytes,
  readRaw
}: {
  processingId: string;
  envelope: EmailEnvelope;
  rawSize: number;
  maxParseBytes: number;
  readRaw: () => Promise<Uint8Array>;
}): Promise<ParsedEmailForProcessing> {
  let parsed: ParsedEmailForProcessing;

  if (rawSize > maxParseBytes) {
    parsed = {
      ...buildHeaderOnlyParsedEmail(envelope),
      parse_skipped_reason: "skipped_large_email"
    };
    logInfo("email_parse_skipped", {
      processingId,
      parse_skipped_reason: "skipped_large_email",
      rawSize,
      maxParseBytes
    });
  } else {
    const rawBytes = await readRaw();

    try {
      parsed = await parseMimeEmail(rawBytes);
    } catch (error) {
      parsed = buildDegradedParsedEmail(envelope, error);
      logError("email_parse_failed", error, {
        processingId,
        rawSize
      });
    }
  }

  logInfo("email_received", {
    processingId,
    rawSize,
    parse_done: parsed.parse_done
  });

  return {
    ...parsed,
    to: [envelope.to],
    rawSize,
    maxParseBytes
  };
}

async function parseMimeEmail(
  rawBytes: Uint8Array
): Promise<ParsedEmailForProcessing> {
  const parsed: Email = await PostalMime.parse(rawBytes);

  return {
    parse_done: true,
    from: addressToString(parsed.from),
    to: (parsed.to ?? []).flatMap(addressToStrings),
    subject: parsed.subject || "(无主题)",
    text: parsed.text || "",
    html: parsed.html || "",
    date: parsed.date,
    messageId: parsed.messageId,
    headers: normalizeHeaders(parsed.headers)
  };
}

function buildHeaderOnlyParsedEmail(envelope: EmailEnvelope): ParsedEmailForProcessing {
  return {
    parse_done: false,
    from: envelope.from,
    to: [envelope.to],
    subject: findHeader(envelope.headers, "subject") || "(无法解析主题)",
    text: "",
    html: "",
    date: findHeader(envelope.headers, "date") || undefined,
    messageId: findHeader(envelope.headers, "message-id") || undefined,
    headers: envelope.headers
  };
}

function buildDegradedParsedEmail(
  envelope: EmailEnvelope,
  error: unknown
): ParsedEmailForProcessing {
  return {
    ...buildHeaderOnlyParsedEmail(envelope),
    last_error: `parse_failed:${normalizeErrorMessage(error)}`
  };
}

export function findHeader(
  headers: Array<{ key: string; value: string }>,
  key: string
): string | undefined {
  return headers.find((header) => header.key === key)?.value;
}

function addressToString(address: Address | undefined): string {
  return addressToStrings(address)[0] ?? "";
}

function addressToStrings(address: Address | undefined): string[] {
  if (!address) {
    return [];
  }

  if ("group" in address && address.group) {
    return address.group.map((mailbox) => mailbox.address).filter(Boolean);
  }

  return address.address ? [address.address] : [];
}

function normalizeHeaders(headers: Header[]): Array<{ key: string; value: string }> {
  return headers.map((header) => ({
    key: header.key.toLowerCase(),
    value: header.value
  }));
}

export function headersToEntries(headers: Headers): Array<{ key: string; value: string }> {
  return Array.from(headers.entries()).map(([key, value]) => ({
    key: key.toLowerCase(),
    value
  }));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }

  return String(error).trim() || "unknown";
}
