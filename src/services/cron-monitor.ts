import type { Env } from "../types";
import { parsePositiveInteger } from "./config";
import { renewGmailDirectWatch, syncGmailDirectMessages } from "./gmail-direct";
import { runTelegramCompensation } from "./telegram-compensation";
import { logError, logInfo } from "../utils/logging";

export const CRON_LOCK_KEY = "cron:lock";

const DEFAULT_CRON_LOCK_TTL_SECONDS = 240;

export interface RunScheduledMaintenanceOptions {
  now?: Date;
  cron?: string;
}

export async function runScheduledMaintenance(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: RunScheduledMaintenanceOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const cron = options.cron;
  const lockTtlSeconds = parsePositiveInteger(
    env.CRON_LOCK_TTL_SECONDS,
    DEFAULT_CRON_LOCK_TTL_SECONDS
  );

  logInfo("scheduled_maintenance_started", {
    cron,
    now: now.toISOString()
  });

  const lock = await tryAcquireCronLock(env.MAIL_KV, {
    now,
    cron,
    lockTtlSeconds
  });

  if (!lock.acquired) {
    logInfo("scheduled_maintenance_lock_skipped", { cron });
    return;
  }

  try {
    await runTelegramCompensation(env, { now }).catch((error) => {
      logError("telegram_compensation_failed", error);
    });
    const renewed = await renewGmailDirectWatch(env, now).catch((error) => {
      logError("gmail_direct_watch_failed", error);
      return false;
    });

    // 续期正常每天一次，随后同步一次：直收邮件间隔很长时同步位置不会过期，推送时处理失败的邮件也不必等下一次推送。
    if (renewed) {
      await syncGmailDirectMessages(env, ctx).catch((error) => {
        logError("gmail_direct_sync_failed", error);
      });
    }
  } finally {
    await releaseCronLock(env.MAIL_KV);
  }
}

async function tryAcquireCronLock(
  kv: KVNamespace,
  input: { now: Date; cron?: string; lockTtlSeconds: number }
): Promise<{ acquired: boolean }> {
  const { lockTtlSeconds } = input;

  try {
    const existing = await kv.get(CRON_LOCK_KEY);

    if (existing) {
      return { acquired: false };
    }

    await kv.put(
      CRON_LOCK_KEY,
      JSON.stringify({
        acquired_at: input.now.toISOString(),
        cron: input.cron
      }),
      { expirationTtl: lockTtlSeconds }
    );

    return { acquired: true };
  } catch (error) {
    logError("cron_lock_acquire_failed", error, {
      cron: input.cron
    });
    return { acquired: false };
  }
}

async function releaseCronLock(kv: KVNamespace): Promise<void> {
  try {
    await kv.delete(CRON_LOCK_KEY);
  } catch (error) {
    logError("cron_lock_release_failed", error);
  }
}
