import { runScheduledMaintenance } from "../services/cron-monitor";
import type { Env } from "../types";
import { logError } from "../utils/logging";

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  try {
    await runScheduledMaintenance(env, {
      cron: controller.cron,
      now: new Date(controller.scheduledTime)
    });
  } catch (error) {
    logError("scheduled_handler_failed", error, {
      cron: controller.cron
    });
  }
}
