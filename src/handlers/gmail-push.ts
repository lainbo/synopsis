import type { Context } from "hono";
import { getGmailDirectConfig, syncGmailDirectMessages } from "../services/gmail-direct";
import type { Env } from "../types";
import { logError } from "../utils/logging";

type AppContext = Context<{ Bindings: Env }>;

export function gmailPushHandler(c: AppContext) {
  if (!getGmailDirectConfig(c.env)) {
    return c.notFound();
  }

  const secret = c.env.GMAIL_DIRECT_PUSH_SECRET?.trim();

  if (!secret || c.req.query("token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 推送内容只用来唤醒同步。先确认再后台同步，避免 Pub/Sub 因超时或失败重投；
  // 同步失败时同步位置不前进，下一次推送会重新拉取。
  c.executionCtx.waitUntil(
    syncGmailDirectMessages(c.env, c.executionCtx).catch((error) => {
      logError("gmail_direct_sync_failed", error);
    })
  );

  return c.json({ ok: true });
}
