import { base64Encode } from "./base64url";
import { getRequiredEnv } from "./config";
import type { ParsedEmailForProcessing } from "./mime-parser";
import type { Env } from "../types";

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TEXT =
  "原邮件没有可用的纯文本内容，完整原件见附件 original.eml。";

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
        subject: parsed.subject || "(无主题)",
        text: parsed.text || DEFAULT_TEXT,
        html: parsed.html || undefined,
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
    sanitizeReason(record.name) ??
    sanitizeReason(record.error) ??
    sanitizeReason(record.reason) ??
    "resend_failed"
  );
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const reason = value.trim();

  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reason)) {
    return reason;
  }

  return null;
}
