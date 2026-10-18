import { base64UrlDecode } from "./base64url";
import { getMaxParseBytes, getRequiredEnv } from "./config";
import { GmailApiError, gmailUserUrl, readGmailJson } from "./gmail-api";
import { putKvValue } from "./kv-write";
import { findHeader, parseEmailForProcessing } from "./mime-parser";
import {
  buildTelegramPendingPatch,
  startEmailNotification
} from "./notification-orchestrator";
import { isProcessingId } from "./processing-id";
import {
  buildParseStatePatch,
  loadProcessingState,
  mergeProcessingState
} from "./processing-state";
import {
  sendGmailDirectCursorResetAlert,
  sendGmailDirectWatchAlert
} from "./reliability-alerts";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

const WATCH_KEY = "gmail-direct:watch";
const CURSOR_KEY = "gmail-direct:cursor";
const WATCH_ALERT_KEY = "gmail-direct:watch_alert";
const WATCH_ALERT_TTL_SECONDS = 86400;
// watch 最长 7 天有效，Google 建议每天续期一次。
const WATCH_RENEW_BEFORE_MS = 6 * 24 * 60 * 60 * 1000;

interface GmailDirectConfig {
  topic: string;
  label: string;
}

interface GmailDirectWatch extends GmailDirectConfig {
  labelId: string;
  expiration: number;
  historyId: string;
}

interface GmailMessage {
  labelIds?: string[];
  sizeEstimate: number;
  payload: { headers: Array<{ name: string; value: string }> };
}

interface GmailHistoryPage {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId: string;
  nextPageToken?: string;
}

export function getGmailDirectConfig(env: Env): GmailDirectConfig | null {
  const topic = env.GMAIL_DIRECT_TOPIC?.trim();

  return topic ? { topic, label: getRequiredEnv(env, "GMAIL_DIRECT_LABEL") } : null;
}

export async function renewGmailDirectWatch(env: Env, now: Date): Promise<void> {
  const config = getGmailDirectConfig(env);

  if (!config) {
    return;
  }

  const watch = await env.MAIL_KV.get<GmailDirectWatch>(WATCH_KEY, "json");

  if (
    watch?.topic === config.topic &&
    watch.label === config.label &&
    watch.expiration - now.getTime() > WATCH_RENEW_BEFORE_MS
  ) {
    return;
  }

  try {
    const labelId = await findLabelId(env, config.label);
    const result = await readGmailJson<{ historyId: string; expiration: string }>(
      env,
      "watch",
      gmailUserUrl(env, "/watch"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topicName: config.topic,
          labelIds: [labelId],
          labelFilterBehavior: "include"
        })
      }
    );
    const expiration = Number(result.expiration);
    const next: GmailDirectWatch = { ...config, labelId, expiration, historyId: result.historyId };

    await putKvValue(env.MAIL_KV, WATCH_KEY, JSON.stringify(next));
    logInfo("gmail_direct_watch_renewed", { expiration });
  } catch (error) {
    await sendWatchAlertOnce(env, error);
    throw error;
  }
}

export async function syncGmailDirectMessages(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<void> {
  const watch = await env.MAIL_KV.get<GmailDirectWatch>(WATCH_KEY, "json");

  if (!watch) {
    logInfo("gmail_direct_sync_skipped", { reason: "watch_missing" });
    return;
  }

  // 尚无同步位置时从建立监听时的位置开始，避免漏掉 Pub/Sub 订阅就绪前到达的邮件。
  const cursor = (await env.MAIL_KV.get(CURSOR_KEY)) ?? watch.historyId;
  const added = await listAddedMessageIds(env, cursor, watch.labelId);

  if (!added) {
    await resetCursor(env);
    const alert = await sendGmailDirectCursorResetAlert(env);

    if (!alert.ok) {
      logError("gmail_direct_cursor_alert_failed", alert.reason);
    }
    return;
  }

  let failed = false;

  for (const messageId of added.messageIds) {
    try {
      await ingestGmailDirectMessage(env, ctx, messageId);
    } catch (error) {
      failed = true;
      logError("gmail_direct_message_failed", error, { gmail_message_id: messageId });
    }
  }

  // 有邮件失败时保留原同步位置，下一次推送重新拉取；已处理的邮件按处理状态跳过。
  if (!failed && added.historyId !== cursor) {
    await putKvValue(env.MAIL_KV, CURSOR_KEY, added.historyId);
  }
}

async function ingestGmailDirectMessage(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  messageId: string
): Promise<void> {
  const processingId = `gmail:${messageId}`;
  const existing = await loadProcessingState(env.MAIL_KV, processingId);

  if (existing.backup_done === true) {
    return;
  }

  const messageUrl = gmailUserUrl(env, `/messages/${encodeURIComponent(messageId)}`);
  let message: GmailMessage;

  try {
    message = await readGmailJson<GmailMessage>(env, "message_get", `${messageUrl}?format=metadata`);
  } catch (error) {
    // 同步前已被彻底删除的邮件无需通知，也不能卡住同步位置。
    if (error instanceof GmailApiError && error.status === 404) {
      logInfo("gmail_direct_message_skipped", { processingId, reason: "not_found" });
      return;
    }

    throw error;
  }

  const headers = message.payload.headers.map(({ name, value }) => ({
    key: name.toLowerCase(),
    value
  }));
  // 垃圾邮件和被其他过滤器直接删除的邮件不通知；
  // 带 X-Processing-Id 的是本项目发往 Gmail 的兜底邮件，原邮件已经通知过。
  const skippedLabel = message.labelIds?.find((id) => id === "SPAM" || id === "TRASH");
  const skipReason =
    skippedLabel?.toLowerCase() ??
    (isProcessingId(findHeader(headers, "x-processing-id") ?? null) ? "fallback_copy" : null);

  if (skipReason) {
    logInfo("gmail_direct_message_skipped", { processingId, reason: skipReason });
    return;
  }

  const parsed = await parseEmailForProcessing({
    processingId,
    envelope: {
      from: findHeader(headers, "from") ?? "",
      to: findHeader(headers, "delivered-to") ?? "",
      headers
    },
    rawSize: message.sizeEstimate,
    maxParseBytes: getMaxParseBytes(env),
    readRaw: async () => base64UrlDecode(
      (await readGmailJson<{ raw: string }>(env, "message_get", `${messageUrl}?format=raw`)).raw
    )
  });

  const state = await mergeProcessingState(env.MAIL_KV, processingId, {
    ...buildParseStatePatch(parsed),
    ...buildTelegramPendingPatch(existing),
    backup_done: true,
    backup_provider: "gmail",
    backup_done_at: new Date().toISOString(),
    gmail_message_id: messageId,
    incrementAttempt: true
  });

  await startEmailNotification({ env, ctx, processingId, parsed, state });
}

async function listAddedMessageIds(
  env: Env,
  startHistoryId: string,
  labelId: string
): Promise<{ messageIds: Set<string>; historyId: string } | null> {
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let page: GmailHistoryPage;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      labelId,
      historyTypes: "messageAdded"
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    try {
      page = await readGmailJson<GmailHistoryPage>(env, "history", gmailUserUrl(env, `/history?${params}`));
    } catch (error) {
      // 同步位置过旧时 Gmail 返回 404，只能从当前位置重新开始。
      if (error instanceof GmailApiError && error.status === 404) {
        return null;
      }

      throw error;
    }

    for (const record of page.history ?? []) {
      for (const { message } of record.messagesAdded ?? []) {
        messageIds.add(message.id);
      }
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return { messageIds, historyId: page.historyId };
}

async function resetCursor(env: Env): Promise<void> {
  const { historyId } = await readGmailJson<{ historyId: string }>(
    env,
    "profile",
    gmailUserUrl(env, "/profile")
  );

  await putKvValue(env.MAIL_KV, CURSOR_KEY, historyId);
  logInfo("gmail_direct_cursor_reset", { historyId });
}

async function findLabelId(env: Env, name: string): Promise<string> {
  const { labels } = await readGmailJson<{ labels: Array<{ id: string; name: string }> }>(
    env,
    "labels",
    gmailUserUrl(env, "/labels")
  );
  const label = labels.find((item) => item.name === name);

  if (!label) {
    throw new GmailApiError("Gmail label not found", "gmail_direct_label_not_found");
  }

  return label.id;
}

// 续期每 5 分钟重试一次，告警每天最多发送一次。
async function sendWatchAlertOnce(env: Env, error: unknown): Promise<void> {
  if ((await env.MAIL_KV.get(WATCH_ALERT_KEY)) !== null) {
    return;
  }

  const alert = await sendGmailDirectWatchAlert(env, error);

  if (!alert.ok) {
    logError("gmail_direct_watch_alert_failed", alert.reason);
    return;
  }

  await env.MAIL_KV.put(WATCH_ALERT_KEY, "1", { expirationTtl: WATCH_ALERT_TTL_SECONDS });
}
