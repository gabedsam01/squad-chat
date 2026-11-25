import { afterEach, expect, test } from "bun:test";
import { ProxyRelay } from "../../runner/model-proxy-relay";

/** The loopback relay a pooled OpenCode process reaches the server's model proxy through (ADR 9007). */

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("the relay adds the running turn's bearer, streams the answer back, and refuses when no turn runs", async () => {
  const seen: { auth: string | null; path: string; body: string }[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname, body: await req.text() });
      return new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const relay = new ProxyRelay();
  stops.push(
    () => upstream.stop(true),
    () => relay.close(),
  );
  let bearer: string | undefined;
  const base = relay.register("proc-1", `http://127.0.0.1:${upstream.port}/api/model-proxy/v1`, () => bearer);
  const call = () =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer relay", "content-type": "application/json" },
      body: '{"x":1}',
    });

  // Idle process: nothing reaches the server.
  expect((await call()).status).toBe(401);
  expect(seen).toHaveLength(0);

  // Two turns of one process, two bearers; the process's own placeholder key is never forwarded.
  bearer = "turn-token-1";
  const first = await call();
  expect(await first.text()).toBe("data: hi\n\n");
  bearer = "turn-token-2";
  await call();
  expect(seen).toEqual([
    { auth: "Bearer turn-token-1", path: "/api/model-proxy/v1/chat/completions", body: '{"x":1}' },
    { auth: "Bearer turn-token-2", path: "/api/model-proxy/v1/chat/completions", body: '{"x":1}' },
  ]);

  // A path nobody holds, or a forgotten process, is refused.
  expect((await fetch(base.replace("proc-1", "other"))).status).toBe(404);
  relay.forget("proc-1");
  expect((await call()).status).toBe(404);
});
