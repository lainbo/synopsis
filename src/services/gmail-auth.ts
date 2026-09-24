import { getRequiredEnv } from "./config";
import type { Env } from "../types";

const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const EARLY_REFRESH_MS = 60000;

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export class GmailAuthError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(message: string, reason: string, status?: number) {
    super(message);
    this.name = "GmailAuthError";
    this.reason = reason;
    this.status = status;
  }
}

export function clearGmailAccessTokenCache(): void {
  cachedToken = null;
}

export async function getGmailAccessToken(
  env: Env,
  options: { forceRefresh?: boolean; now?: number } = {}
): Promise<string> {
  const now = options.now ?? Date.now();

  if (
    cachedToken &&
    options.forceRefresh !== true &&
    cachedToken.expiresAt - EARLY_REFRESH_MS > now
  ) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: getRequiredEnv(env, "GMAIL_CLIENT_ID"),
    client_secret: getRequiredEnv(env, "GMAIL_CLIENT_SECRET"),
    refresh_token: getRequiredEnv(env, "GMAIL_REFRESH_TOKEN"),
    grant_type: "refresh_token"
  });

  let response: Response;

  try {
    response = await fetch(GMAIL_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
  } catch {
    throw new GmailAuthError("Gmail token refresh failed", "token_fetch_failed");
  }

  if (!response.ok) {
    throw new GmailAuthError(
      "Gmail token refresh failed",
      await parseErrorReason(response),
      response.status
    );
  }

  const payload = await parseTokenResponse(response);

  cachedToken = {
    accessToken: payload.accessToken,
    expiresAt: now + payload.expiresIn * 1000
  };

  return payload.accessToken;
}

async function parseTokenResponse(
  response: Response
): Promise<{ accessToken: string; expiresIn: number }> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new GmailAuthError(
      "Invalid Gmail token response",
      "invalid_token_response"
    );
  }

  if (!isTokenResponse(payload)) {
    throw new GmailAuthError(
      "Invalid Gmail token response",
      "invalid_token_response"
    );
  }

  return {
    accessToken: payload.access_token.trim(),
    expiresIn: payload.expires_in
  };
}

async function parseErrorReason(response: Response): Promise<string> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return "token_refresh_failed";
  }

  if (!payload || typeof payload !== "object") {
    return "token_refresh_failed";
  }

  const record = payload as Record<string, unknown>;
  const error = sanitizeReason(record.error);

  if (error) {
    return error;
  }

  return sanitizeReason(record.error_description) ?? "token_refresh_failed";
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

function isTokenResponse(
  value: unknown
): value is { access_token: string; expires_in: number } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.access_token === "string" &&
    record.access_token.trim() !== "" &&
    typeof record.expires_in === "number" &&
    Number.isFinite(record.expires_in) &&
    record.expires_in > 0
  );
}
