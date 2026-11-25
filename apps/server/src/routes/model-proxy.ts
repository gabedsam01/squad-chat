import { type RateLimiter, retryInSeconds } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { type ModelGateway, proxyChat, proxyModels, sha256, verifyRunToolTokenForProxy } from "@agenteschat/engine";
import { type Context, Hono } from "hono";
import type { Logger } from "../logger";

/** Calls per turn token per minute: a tool loop makes one per step, so this is far above any real run. */
const CALLS_PER_MINUTE = { limit: 600, windowMs: 60_000 };

export interface ModelProxyRouteDeps {
  db: Database;
  gateway: Pick<ModelGateway, "stream">;
  rateLimiter: RateLimiter;
  /** The server's cap (`AGENT_MAX_OUTPUT_TOKENS`). */
  maxOutputTokens?: number;
  log?: Logger;
}

type Vars = { Variables: { identity: { orgId: string; agentId: string; runId: string } } };

/**
 * The model proxy OpenCode thinks through (ADR 9007), mounted at `/api/model-proxy/v1`: OpenAI's Chat Completions and
 * model list, nothing else. Server to computer, no session or CSRF: the bearer is the turn's run tool token. Errors
 * use OpenAI's shape (`{ error: { message, type, code } }`), which its clients read.
 */
export function modelProxyRoutes(deps: ModelProxyRouteDeps) {
  const app = new Hono<Vars>();
  const { db, gateway, rateLimiter, log } = deps;
  const refuse = (c: Context, status: 401 | 429, code: string, message: string) =>
    c.json({ error: { message, type: status === 429 ? "rate_limit_error" : "invalid_request_error", code } }, status);

  app.use("*", async (c, next) => {
    const token = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
    const who = await verifyRunToolTokenForProxy(db, token);
    if (!who.ok) return refuse(c, 401, who.error.code, who.error.message);
    const limit = await rateLimiter.consume(`model-proxy:${sha256(token)}`, CALLS_PER_MINUTE);
    if (!limit.allowed) {
      c.header("retry-after", String(retryInSeconds(limit.resetAt)));
      return refuse(c, 429, "rate_limited", "Too many model calls for this turn. Try again shortly.");
    }
    c.set("identity", who.identity);
    await next();
  });

  app.get("/models", (c) => c.json(proxyModels()));

  app.post("/chat/completions", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const reply = await proxyChat(
      {
        db,
        gateway,
        ...(log ? { log } : {}),
        ...(deps.maxOutputTokens ? { maxOutputTokens: deps.maxOutputTokens } : {}),
      },
      c.get("identity"),
      body,
      c.req.raw.signal,
    );
    if (reply.kind === "json") return c.json(reply.body as object, reply.status as 200);
    return new Response(reply.stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  });

  app.onError((error, c) => {
    log?.error("model proxy: unhandled error", { path: c.req.path, error: String(error) });
    return c.json({ error: { message: "Something went wrong on our side", type: "api_error", code: "internal" } }, 500);
  });

  return app;
}
