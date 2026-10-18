import { getGmailAccessToken } from "./gmail-auth";
import { getGmailUserId } from "./config";
import type { Env } from "../types";
import { sanitizeErrorReason } from "../utils/error-reason";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const GMAIL_UPLOAD_API_BASE = "https://gmail.googleapis.com/upload/gmail/v1";

export class GmailApiError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(message: string, reason: string, status?: number) {
    super(message);
    this.name = "GmailApiError";
    this.reason = reason;
    this.status = status;
  }
}

interface GmailRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}

export function gmailUserUrl(env: Env, path: string, base = GMAIL_API_BASE): string {
  return `${base}/users/${encodeURIComponent(getGmailUserId(env))}${path}`;
}

export async function fetchGmail(
  env: Env,
  operation: string,
  url: string,
  init: GmailRequestInit = {}
): Promise<Response> {
  const send = async (forceRefresh: boolean) => {
    const accessToken = await getGmailAccessToken(env, { forceRefresh });

    try {
      return await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessToken}` }
      });
    } catch {
      throw new GmailApiError(`Gmail ${operation} failed`, `gmail_${operation}_fetch_failed`);
    }
  };

  const response = await send(false);

  if (response.status !== 401) {
    return response;
  }

  const retried = await send(true);

  if (retried.status === 401) {
    throw new GmailApiError(`Gmail ${operation} failed`, "gmail_401_after_refresh", 401);
  }

  return retried;
}

export async function readGmailJson<T>(
  env: Env,
  operation: string,
  url: string,
  init?: GmailRequestInit
): Promise<T> {
  const response = await fetchGmail(env, operation, url, init);

  if (!response.ok) {
    throw await toGmailApiError(response, operation);
  }

  try {
    return await response.json<T>();
  } catch {
    throw new GmailApiError(
      `Gmail ${operation} failed`,
      `invalid_gmail_${operation}_response`,
      response.status
    );
  }
}

export async function toGmailApiError(
  response: Response,
  operation: string
): Promise<GmailApiError> {
  return new GmailApiError(
    `Gmail ${operation} failed`,
    await parseErrorReason(response, `gmail_${operation}_failed`),
    response.status
  );
}

async function parseErrorReason(response: Response, fallback: string): Promise<string> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return fallback;
  }

  return extractReason(payload) ?? fallback;
}

function extractReason(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const error = record.error;

  if (typeof error === "string") {
    return sanitizeErrorReason(error);
  }

  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    return sanitizeErrorReason(nested.status) ?? sanitizeErrorReason(nested.reason);
  }

  return sanitizeErrorReason(record.reason);
}
