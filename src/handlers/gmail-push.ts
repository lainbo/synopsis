import type { Context } from "hono";
import { base64UrlDecode } from "../services/base64url";
import {
  findGmailDirectAccount,
  getGmailDirectConfig,
  syncGmailDirectMessages
} from "../services/gmail-direct";
import type { Env } from "../types";
import { logError, logInfo } from "../utils/logging";

type AppContext = Context<{ Bindings: Env }>;

// 低于 Pub/Sub 推送订阅默认的 10 秒确认期限，超过期限未响应会被重投。
const PUSH_SYNC_WAIT_MS = 8000;

export async function gmailPushHandler(c: AppContext) {
  const config = getGmailDirectConfig(c.env);

  if (!config) {
    return c.notFound();
  }

  const secret = c.env.GMAIL_DIRECT_PUSH_SECRET?.trim();

  if (!secret || c.req.query("token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const emailAddress = await readPushEmailAddress(c);
  const account =
    emailAddress && await findGmailDirectAccount(c.env, config.accounts, emailAddress);

  // 监听记录尚未写入该邮箱地址时返回 404，Pub/Sub 按订阅设置重投，等 Cron 续期补上地址。
  if (!account) {
    logInfo("gmail_direct_push_unmatched");
    return c.notFound();
  }

  // 推送内容只用来确定账号并唤醒同步。同步失败时照常确认，避免 Pub/Sub 重投；
  // 同步位置不前进，下一次推送会重新拉取。
  const sync = syncGmailDirectMessages(c.env, c.executionCtx, account).catch((error) => {
    logError("gmail_direct_sync_failed", error, { account });
  });

  // 后台任务只能在响应后再运行 30 秒，同步和它发起的摘要通知共用这段时间。先等同步结束再确认，
  // 通知就有完整的 30 秒；同步较慢时最多等待 PUSH_SYNC_WAIT_MS，剩余部分转入后台。
  c.executionCtx.waitUntil(sync);
  await Promise.race([sync, new Promise((resolve) => setTimeout(resolve, PUSH_SYNC_WAIT_MS))]);

  return c.json({ ok: true });
}

// Pub/Sub 推送体的 message.data 是 Gmail 通知的 base64 编码，emailAddress 为发生变化的邮箱。
async function readPushEmailAddress(c: AppContext): Promise<string | undefined> {
  try {
    const { message } = await c.req.json<{ message?: { data?: string } }>();
    const { emailAddress } = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(message?.data ?? ""))
    ) as { emailAddress?: unknown };

    return typeof emailAddress === "string" ? emailAddress : undefined;
  } catch {
    return undefined;
  }
}
