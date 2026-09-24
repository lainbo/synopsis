const PROCESSING_ID_VERSION = "v1";
const MISSING_DATE = "missing-date";

export async function buildProcessingId(
  message: ForwardableEmailMessage,
  rawBytes: Uint8Array
): Promise<string> {
  const messageId = normalizeMessageId(message.headers.get("message-id"));

  if (!messageId) {
    return `v1raw:${await sha256Hex(rawBytes)}`;
  }

  const payload = {
    version: PROCESSING_ID_VERSION,
    messageId,
    envelopeTo: normalizeAddress(message.to),
    date: normalizeDate(message.headers.get("date")),
    envelopeFrom: normalizeAddress(message.from)
  };

  return `v1:${await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)))}`;
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
