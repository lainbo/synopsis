const PROCESSING_ID_VERSION = "v1";
const RAW_PROCESSING_ID_PREFIX = "v2raw";
const MISSING_DATE = "missing-date";
const PROCESSING_ID_PATTERN = new RegExp(
  `^(${PROCESSING_ID_VERSION}|${RAW_PROCESSING_ID_PREFIX}):[0-9a-f]{64}$`
);

export async function buildProcessingId(
  message: ForwardableEmailMessage,
  rawBytes: Uint8Array
): Promise<string> {
  const messageId = normalizeMessageId(message.headers.get("message-id"));

  if (!messageId) {
    const payload = {
      rawHash: await sha256Hex(rawBytes),
      envelopeTo: normalizeAddress(message.to),
      envelopeFrom: normalizeAddress(message.from)
    };
    return `${RAW_PROCESSING_ID_PREFIX}:${await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)))}`;
  }

  const payload = {
    version: PROCESSING_ID_VERSION,
    messageId,
    envelopeTo: normalizeAddress(message.to),
    date: normalizeDate(message.headers.get("date")),
    envelopeFrom: normalizeAddress(message.from)
  };

  return `${PROCESSING_ID_VERSION}:${await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

export function isProcessingId(value: string | null): boolean {
  return PROCESSING_ID_PATTERN.test(value?.trim() ?? "");
}

function normalizeMessageId(value: string | null): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.replace(/^<(.+)>$/, "$1");
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDate(value: string | null): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return MISSING_DATE;
  }

  const timestamp = Date.parse(trimmed);

  if (Number.isNaN(timestamp)) {
    return `invalid-date:${trimmed}`;
  }

  return new Date(timestamp).toISOString();
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
