import PostalMime from "postal-mime";
import type { Address, Email, Header } from "postal-mime";

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

export async function parseMimeEmail(
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

export function buildDegradedParsedEmail(
  message: ForwardableEmailMessage,
  error: unknown,
  rawSize: number
): ParsedEmailForProcessing {
  return {
    parse_done: false,
    last_error: `parse_failed:${normalizeErrorMessage(error)}`,
    from: message.from,
    to: [message.to],
    subject: message.headers.get("subject") || "(无法解析主题)",
    text: "",
    html: "",
    date: message.headers.get("date") || undefined,
    messageId: message.headers.get("message-id") || undefined,
    headers: headersToEntries(message.headers),
    rawSize
  };
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

function headersToEntries(headers: Headers): Array<{ key: string; value: string }> {
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
