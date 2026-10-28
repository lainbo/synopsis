import { base64UrlDecode } from "./base64url";
import {
  getMaxParseBytes,
  getRequiredEnv,
  gmailAccountVar,
  PRIMARY_GMAIL_ACCOUNT
} from "./config";
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

// 第 2 个起的直收账号由带编号的 refresh token 变量确定。
const EXTRA_ACCOUNT_PATTERN = /^GMAIL_REFRESH_TOKEN_([2-9]|[1-9]\d+)$/;
const WATCH_ALERT_TTL_SECONDS = 86400;
// watch 最长 7 天有效，Google 建议每天续期一次。
const WATCH_RENEW_BEFORE_MS = 6 * 24 * 60 * 60 * 1000;

interface GmailDirectConfig {
  topic: string;
  accounts: string[];
}

interface GmailDirectWatch {
  topic: string;
  label: string;
  labelId: string;
  emailAddress?: string;
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

  if (!topic) {
    return null;
  }

  const extraAccounts = Object.keys(env)
    .flatMap((key) => EXTRA_ACCOUNT_PATTERN.exec(key)?.[1] ?? [])
    .sort((a, b) => Number(a) - Number(b));

  return { topic, accounts: [PRIMARY_GMAIL_ACCOUNT, ...extraAccounts] };
}

// 推送通知中的 emailAddress 与建立监听时记录的邮箱地址对应到账号。
export async function findGmailDirectAccount(
  env: Env,
  accounts: string[],
  emailAddress: string
): Promise<string | undefined> {
  const address = emailAddress.toLowerCase();

  for (const account of accounts) {
    const watch = await loadWatch(env, account);

    if (watch?.emailAddress?.toLowerCase() === address) {
      return account;
    }
  }

  return undefined;
}

export async function renewGmailDirectWatch(
  env: Env,
  topic: string,
  account: string,
  now: Date
): Promise<void> {
  const watch = await loadWatch(env, account);

  try {
    const label = getRequiredEnv(env, gmailAccountVar("GMAIL_DIRECT_LABEL", account));

    if (
      watch?.emailAddress &&
      watch.topic === topic &&
      watch.label === label &&
      watch.expiration - now.getTime() > WATCH_RENEW_BEFORE_MS
    ) {
      return;
    }

    const labelId = await findLabelId(env, account, label);
    const { emailAddress } = await readProfile(env, account);
    const result = await readGmailJson<{ historyId: string; expiration: string }>(
      env,
      account,
      "watch",
      gmailUserUrl(env, account, "/watch"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topicName: topic,
          labelIds: [labelId],
          labelFilterBehavior: "include"
        })
      }
    );
    const expiration = Number(result.expiration);
    const next: GmailDirectWatch = {
      topic,
      label,
      labelId,
      emailAddress,
      expiration,
      historyId: result.historyId
    };

    await putKvValue(env.MAIL_KV, directKey(account, "watch"), JSON.stringify(next));
    logInfo("gmail_direct_watch_renewed", { account, expiration });
  } catch (error) {
    await sendWatchAlertOnce(env, account, error);
    throw error;
  }
}

export async function syncGmailDirectMessages(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  account: string
): Promise<void> {
  const watch = await loadWatch(env, account);

  if (!watch) {
    logInfo("gmail_direct_sync_skipped", { account, reason: "watch_missing" });
    return;
  }

  const cursorKey = directKey(account, "cursor");
  // 尚无同步位置时从建立监听时的位置开始，避免漏掉 Pub/Sub 订阅就绪前到达的邮件。
  const cursor = (await env.MAIL_KV.get(cursorKey)) ?? watch.historyId;
  const added = await listAddedMessageIds(env, account, cursor, watch.labelId);

  if (!added) {
    await resetCursor(env, account);
    const alert = await sendGmailDirectCursorResetAlert(env, account);

    if (!alert.ok) {
      logError("gmail_direct_cursor_alert_failed", alert.reason, { account });
    }
    return;
  }

  let failed = false;

  for (const messageId of added.messageIds) {
    try {
      await ingestGmailDirectMessage(env, ctx, account, messageId);
    } catch (error) {
      failed = true;
      logError("gmail_direct_message_failed", error, { account, gmail_message_id: messageId });
    }
  }

  // 有邮件失败时保留原同步位置，下一次推送重新拉取；已处理的邮件按处理状态跳过。
  if (!failed && added.historyId !== cursor) {
    await putKvValue(env.MAIL_KV, cursorKey, added.historyId);
  }
}

async function ingestGmailDirectMessage(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  account: string,
  messageId: string
): Promise<void> {
  const processingId = `${withAccount("gmail", account)}:${messageId}`;
  const existing = await loadProcessingState(env.MAIL_KV, processingId);

  if (existing.backup_done === true) {
    return;
  }

  const messageUrl = gmailUserUrl(env, account, `/messages/${encodeURIComponent(messageId)}`);
  let message: GmailMessage;

  try {
    message = await readGmailJson<GmailMessage>(
      env,
      account,
      "message_get",
      `${messageUrl}?format=metadata`
    );
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
      (await readGmailJson<{ raw: string }>(
        env,
        account,
        "message_get",
        `${messageUrl}?format=raw`
      )).raw
    )
  });

  const state = await mergeProcessingState(env.MAIL_KV, processingId, {
    ...buildParseStatePatch(parsed),
    ...buildTelegramPendingPatch(existing),
    backup_done: true,
    backup_provider: "gmail",
    backup_done_at: new Date().toISOString(),
    gmail_message_id: messageId,
    gmail_account: account,
    incrementAttempt: true
  });

  await startEmailNotification({ env, ctx, processingId, parsed, state });
}

async function listAddedMessageIds(
  env: Env,
  account: string,
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
      page = await readGmailJson<GmailHistoryPage>(
        env,
        account,
        "history",
        gmailUserUrl(env, account, `/history?${params}`)
      );
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

async function resetCursor(env: Env, account: string): Promise<void> {
  const { historyId } = await readProfile(env, account);

  await putKvValue(env.MAIL_KV, directKey(account, "cursor"), historyId);
  logInfo("gmail_direct_cursor_reset", { account, historyId });
}

function readProfile(
  env: Env,
  account: string
): Promise<{ emailAddress: string; historyId: string }> {
  return readGmailJson(env, account, "profile", gmailUserUrl(env, account, "/profile"));
}

async function findLabelId(env: Env, account: string, name: string): Promise<string> {
  const { labels } = await readGmailJson<{ labels: Array<{ id: string; name: string }> }>(
    env,
    account,
    "labels",
    gmailUserUrl(env, account, "/labels")
  );
  const label = labels.find((item) => item.name === name);

  if (!label) {
    throw new GmailApiError("Gmail label not found", "gmail_direct_label_not_found");
  }

  return label.id;
}

// 续期每 5 分钟重试一次，告警每天最多发送一次。
async function sendWatchAlertOnce(env: Env, account: string, error: unknown): Promise<void> {
  const alertKey = directKey(account, "watch_alert");

  if ((await env.MAIL_KV.get(alertKey)) !== null) {
    return;
  }

  const alert = await sendGmailDirectWatchAlert(env, account, error);

  if (!alert.ok) {
    logError("gmail_direct_watch_alert_failed", alert.reason, { account });
    return;
  }

  await env.MAIL_KV.put(alertKey, "1", { expirationTtl: WATCH_ALERT_TTL_SECONDS });
}

function loadWatch(env: Env, account: string): Promise<GmailDirectWatch | null> {
  return env.MAIL_KV.get<GmailDirectWatch>(directKey(account, "watch"), "json");
}

function directKey(account: string, name: "watch" | "cursor" | "watch_alert"): string {
  return `${withAccount("gmail-direct", account)}:${name}`;
}

// 账号 1 的 KV 键和处理编号不带账号编号，与变量命名一致。
function withAccount(prefix: string, account: string): string {
  return account === PRIMARY_GMAIL_ACCOUNT ? prefix : `${prefix}:${account}`;
}
