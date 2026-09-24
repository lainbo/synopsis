import type { Env } from "../types";
import { runTelegramCompensation } from "./telegram-compensation";
import { logError, logInfo } from "../utils/logging";

export const CRON_LOCK_KEY = "cron:lock";

const DEFAULT_CRON_LOCK_TTL_SECONDS = 240;

export interface ScheduledMaintenanceHooks {
  compensateTelegram?: () => Promise<void>;
}

export interface RunScheduledMaintenanceOptions {
  now?: Date;
  cron?: string;
  hooks?: ScheduledMaintenanceHooks;
}

export async function runScheduledMaintenance(
  env: Env,
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
    await runCompensationHook(getCompensationHook(env, now, options.hooks));
  } finally {
    await releaseCronLock(env.MAIL_KV);
  }
}

function getCompensationHook(
  env: Env,
  now: Date,
  hooks: ScheduledMaintenanceHooks | undefined
): () => Promise<void> {
  return hooks?.compensateTelegram ?? (() => runTelegramCompensation(env, { now }));
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

async function runCompensationHook(
  hook: (() => Promise<void>) | undefined
): Promise<void> {
  if (!hook) {
    return;
  }

  try {
    await hook();
  } catch (error) {
    logError("telegram_compensation_failed", error);
  }
}

async function releaseCronLock(kv: KVNamespace): Promise<void> {
  try {
    await kv.delete(CRON_LOCK_KEY);
  } catch (error) {
    logError("cron_lock_release_failed", error);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}
