import {
  fetchGmail,
  GMAIL_UPLOAD_API_BASE,
  GmailApiError,
  gmailUserUrl,
  readGmailJson,
  toGmailApiError
} from "./gmail-api";
import type { Env } from "../types";

export async function insertGmailMessage(
  env: Env,
  rawBytes: Uint8Array
): Promise<{ id: string; threadId?: string }> {
  const boundary = createMultipartBoundary();
  const record = await readGmailJson<{ id?: unknown; threadId?: unknown } | null>(
    env,
    "insert",
    gmailUserUrl(
      env,
      "/messages?uploadType=multipart&internalDateSource=dateHeader",
      GMAIL_UPLOAD_API_BASE
    ),
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: buildMultipartInsertBody(rawBytes, boundary)
    }
  );

  if (typeof record?.id !== "string" || record.id.trim() === "") {
    throw new GmailApiError("Gmail insert failed", "invalid_gmail_insert_response");
  }

  return {
    id: record.id.trim(),
    threadId: typeof record.threadId === "string" ? record.threadId : undefined
  };
}

export async function trashGmailMessage(
  env: Env,
  messageId: string
): Promise<void> {
  const normalizedMessageId = messageId.trim();

  if (!normalizedMessageId) {
    throw new GmailApiError("Gmail trash failed", "gmail_trash_message_id_missing");
  }

  const messageUrl = gmailUserUrl(env, `/messages/${encodeURIComponent(normalizedMessageId)}`);

  try {
    const message = await readGmailJson<{ labelIds?: string[] }>(
      env,
      "trash",
      `${messageUrl}?format=minimal`
    );

    if (message.labelIds?.includes("TRASH")) {
      return;
    }

    const response = await fetchGmail(env, "trash", `${messageUrl}/trash`, { method: "POST" });

    if (!response.ok) {
      throw await toGmailApiError(response, "trash");
    }
  } catch (error) {
    // 邮件已不存在时与已移入垃圾箱同样视为完成。
    if (error instanceof GmailApiError && error.status === 404) {
      return;
    }

    throw error;
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
