import { app } from "./router";
import { handleEmail } from "./handlers/email";
import { handleScheduled } from "./handlers/scheduled";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleEmail(message, env, ctx);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(controller, env, ctx));
  }
} satisfies ExportedHandler<Env>;
