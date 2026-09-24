import type { Context } from "hono";
import type { Env } from "../types";

type AppContext = Context<{ Bindings: Env }>;

export function healthHandler(c: AppContext) {
  return c.json({
    ok: true,
    service: "synopsis",
    environment: c.env.ENVIRONMENT ?? "development",
    timestamp: new Date().toISOString(),
    capabilities: {
      hono: true,
      kv: Boolean(c.env.MAIL_KV),
      emailWorker: true,
      maxParseBytesConfigured: Boolean(c.env.MAX_PARSE_BYTES)
    }
  });
}
