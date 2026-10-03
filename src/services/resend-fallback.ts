import { base64Encode } from "./base64url";
import { getRequiredEnv } from "./config";
import { buildFallbackEmailContent } from "./fallback-email-content";
import type { ParsedEmailForProcessing } from "./mime-parser";
import type { Env } from "../types";
import { sanitizeErrorReason } from "../utils/error-reason";

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";

export class ResendFallbackError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(reason: string, status?: number) {
    super("Resend fallback failed");
    this.name = "ResendFallbackError";
    this.reason = reason;
    this.status = status;
  }
}

export async function sendResendFallback(
  env: Env,
  processingId: string,
  parsed: ParsedEmailForProcessing,
  rawBytes: Uint8Array
): Promise<{ id?: string }> {
  let response: Response;

  try {
    response = await fetch(RESEND_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getRequiredEnv(env, "RESEND_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": processingId
      },
      body: JSON.stringify({
        from: getRequiredEnv(env, "RESEND_FROM"),
        to: [getRequiredEnv(env, "BACKUP_EMAIL_TO")],
        ...buildFallbackEmailContent(parsed),
        reply_to: parsed.from || undefined,
        headers: {
          "X-Original-From": parsed.from,
          "X-Processing-Id": processingId
        },
        attachments: [
          {
            filename: "original.eml",
            content: base64Encode(rawBytes),
            content_type: "message/rfc822"
          }
        ]
      })
    });
  } catch {
    throw new ResendFallbackError("resend_fetch_failed");
  }

  if (!response.ok) {
    throw new ResendFallbackError(await parseErrorReason(response), response.status);
  }

  return parseSuccessResponse(response);
}

async function parseSuccessResponse(response: Response): Promise<{ id?: string }> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return {};
  }

  if (!payload || typeof payload !== "object") {
    return {};
  }

  const id = (payload as Record<string, unknown>).id;

  return typeof id === "string" && id.trim() ? { id: id.trim() } : {};
}

async function parseErrorReason(response: Response): Promise<string> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return "resend_failed";
  }

  if (!payload || typeof payload !== "object") {
    return "resend_failed";
  }

  const record = payload as Record<string, unknown>;

  return (
    sanitizeErrorReason(record.name) ??
    sanitizeErrorReason(record.error) ??
    sanitizeErrorReason(record.reason) ??
    "resend_failed"
  );
}
