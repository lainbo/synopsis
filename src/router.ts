import { Hono } from "hono";
import { healthHandler } from "./handlers/health";
import { telegramCallbackHandler } from "./handlers/telegram-callback";
import type { Env } from "./types";

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", healthHandler);
app.post("/telegram/webhook", telegramCallbackHandler);

app.notFound((c) => {
  return c.json({ ok: false, error: "not_found" }, 404);
});
