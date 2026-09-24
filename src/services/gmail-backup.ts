import { getGmailAccessToken } from "./gmail-auth";
import { getGmailUserId } from "./config";
import type { Env } from "../types";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_UPLOAD_API_BASE = "https://gmail.googleapis.com/upload/gmail/v1";

export class GmailBackupError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(message: string, reason: string, status?: number) {
    super(message);
    this.name = "GmailBackupError";
    this.reason = reason;
    this.status = status;
  }
}

export async function insertGmailMessage(
  env: Env,
  rawBytes: Uint8Array
): Promise<{ id: string; threadId?: string }> {
  const firstToken = await getGmailAccessToken(env);
  let response = await postGmailMessage(env, rawBytes, firstToken);

  if (response.status === 401) {
    const refreshedToken = await getGmailAccessToken(env, { forceRefresh: true });
    response = await postGmailMessage(env, rawBytes, refreshedToken);

    if (response.status === 401) {
      throw new GmailBackupError(
        "Gmail message insert failed",
        "gmail_401_after_refresh",
        401
      );
    }
  }

  if (!response.ok) {
    throw new GmailBackupError(
      "Gmail message insert failed",
      await parseErrorReason(response),
      response.status
    );
  }

  return parseInsertResponse(response);
}

export async function trashGmailMessage(
  env: Env,
  messageId: string
): Promise<void> {
  const normalizedMessageId = messageId.trim();

  if (!normalizedMessageId) {
    throw new GmailBackupError(
      "Gmail message trash failed",
      "gmail_trash_message_id_missing"
    );
  }

  const firstToken = await getGmailAccessToken(env);
  let response = await trashGmailMessageById(env, normalizedMessageId, firstToken);

  if (response.status === 401) {
    const refreshedToken = await getGmailAccessToken(env, { forceRefresh: true });
    response = await trashGmailMessageById(env, normalizedMessageId, refreshedToken);

    if (response.status === 401) {
      throw new GmailBackupError(
        "Gmail message trash failed",
        "gmail_401_after_refresh",
        401
      );
    }
  }

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    throw new GmailBackupError(
      "Gmail message trash failed",
      await parseErrorReason(response),
      response.status
    );
  }
}

async function postGmailMessage(
  env: Env,
  rawBytes: Uint8Array,
  accessToken: string
): Promise<Response> {
  const userId = encodeURIComponent(getGmailUserId(env));
  const boundary = createMultipartBoundary();
  const body = buildMultipartInsertBody(rawBytes, boundary);

  try {
    return await fetch(
      `${GMAIL_UPLOAD_API_BASE}/users/${userId}/messages?uploadType=multipart&internalDateSource=dateHeader`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": `multipart/related; boundary=${boundary}`
        },
        body
      }
    );
  } catch {
    throw new GmailBackupError(
      "Gmail message insert failed",
      "gmail_insert_fetch_failed"
    );
  }
}

function createMultipartBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `gmail_insert_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function buildMultipartInsertBody(
  rawBytes: Uint8Array,
  boundary: string
): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({ labelIds: ["INBOX"] }),
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "",
      ""
    ].join("\r\n")
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + rawBytes.length + tail.length);

  body.set(head, 0);
  body.set(rawBytes, head.length);
  body.set(tail, head.length + rawBytes.length);

  return body;
}

async function trashGmailMessageById(
  env: Env,
  messageId: string,
  accessToken: string
): Promise<Response> {
  const userId = encodeURIComponent(getGmailUserId(env));
  const messageUrl = `${GMAIL_API_BASE}/users/${userId}/messages/${encodeURIComponent(messageId)}`;
  const headers = { authorization: `Bearer ${accessToken}` };

  try {
    const existing = await fetch(`${messageUrl}?format=minimal`, { headers });

    if (!existing.ok) {
      return existing;
    }

    const message = await existing.json<{ labelIds?: string[] }>();

    if (message.labelIds?.includes("TRASH")) {
      return existing;
    }

    return await fetch(`${messageUrl}/trash`, { method: "POST", headers });
  } catch {
    throw new GmailBackupError(
      "Gmail message trash failed",
      "gmail_trash_fetch_failed"
    );
  }
}

async function parseInsertResponse(
  response: Response
): Promise<{ id: string; threadId?: string }> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new GmailBackupError(
      "Gmail message insert failed",
      "invalid_gmail_insert_response",
      response.status
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new GmailBackupError(
      "Gmail message insert failed",
      "invalid_gmail_insert_response",
      response.status
    );
  }

  const record = payload as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new GmailBackupError(
      "Gmail message insert failed",
      "invalid_gmail_insert_response",
      response.status
    );
  }

  return {
    id: record.id.trim(),
    threadId: typeof record.threadId === "string" ? record.threadId : undefined
  };
}

async function parseErrorReason(response: Response): Promise<string> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return "gmail_insert_failed";
  }

  return extractReason(payload) ?? "gmail_insert_failed";
}

function extractReason(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const error = record.error;

  if (typeof error === "string") {
    return sanitizeReason(error);
  }

  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    return sanitizeReason(nested.status) ?? sanitizeReason(nested.reason);
  }

  return sanitizeReason(record.reason);
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
