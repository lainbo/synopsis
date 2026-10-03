import { getRequiredEnv } from "./config";
import { buildFallbackEmailContent } from "./fallback-email-content";
import type { ParsedEmailForProcessing } from "./mime-parser";
import type { Env } from "../types";

export class CloudflareEmailFallbackError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super("Cloudflare Email fallback failed");
    this.name = "CloudflareEmailFallbackError";
    this.reason = reason;
  }
}

export async function sendCloudflareFallback(
  env: Env,
  processingId: string,
  parsed: ParsedEmailForProcessing,
  rawBytes: Uint8Array
): Promise<{ messageId?: string }> {
  const email = {
    to: getRequiredEnv(env, "BACKUP_EMAIL_TO"),
    from: getRequiredEnv(env, "CF_EMAIL_FROM"),
    ...buildFallbackEmailContent(parsed),
    headers: {
      "X-Original-From": parsed.from,
      "X-Original-To": parsed.to.join(", "),
      "X-Processing-Id": processingId
    },
    attachments: [
      {
        disposition: "attachment" as const,
        filename: "original.eml",
        type: "message/rfc822",
        content: toArrayBuffer(rawBytes)
      }
    ]
  };

  try {
    const response = await env.EMAIL.send(email);

    return typeof response.messageId === "string"
      ? { messageId: response.messageId }
      : {};
  } catch {
    throw new CloudflareEmailFallbackError("cloudflare_email_failed");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}
