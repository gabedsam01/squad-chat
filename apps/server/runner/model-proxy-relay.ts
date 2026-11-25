/**
 * A loopback relay in front of the server's model proxy (ADR 9007). A pooled `opencode acp` process lives across
 * turns but its provider's bearer is fixed when it starts, while the proxy wants the current turn's run tool token.
 * The process talks to this relay under a path only it knows (`/<id>/…`), and the relay adds the bearer of the turn
 * that is running now, so a proxied turn reuses a warm process instead of starting OpenCode cold. It listens on
 * 127.0.0.1 only; with no turn running there is no bearer and nothing is forwarded.
 */
export class ProxyRelay {
  private server: { port: number; stop(force?: boolean): void } | null = null;
  private readonly routes = new Map<string, { upstream: string; bearer: () => string | undefined }>();

  /** Where the process `id` reaches the proxy at `upstream` (`<server>/api/model-proxy/v1`), as its provider's base URL. */
  register(id: string, upstream: string, bearer: () => string | undefined): string {
    this.server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.forward(req) });
    this.routes.set(id, { upstream: upstream.replace(/\/+$/, ""), bearer });
    return `http://127.0.0.1:${this.server.port}/${id}`;
  }

  forget(id: string) {
    this.routes.delete(id);
  }

  close() {
    this.routes.clear();
    this.server?.stop(true);
    this.server = null;
  }

  private async forward(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, id = "", ...rest] = url.pathname.split("/");
    const route = this.routes.get(id);
    const bearer = route?.bearer();
    const refuse = (status: number, message: string) =>
      Response.json({ error: { message, type: "invalid_request_error", code: "relay" } }, { status });
    if (!route) return refuse(404, "Unknown relay path");
    if (!bearer) return refuse(401, "No turn is running on this process");
    const headers = new Headers({ authorization: `Bearer ${bearer}` });
    for (const name of ["content-type", "accept"]) {
      const v = req.headers.get(name);
      if (v) headers.set(name, v);
    }
    try {
      const up = await fetch(`${route.upstream}/${rest.join("/")}${url.search}`, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: await req.arrayBuffer() }),
        signal: req.signal,
      });
      const out = new Headers();
      for (const name of ["content-type", "cache-control", "retry-after"]) {
        const v = up.headers.get(name);
        if (v) out.set(name, v);
      }
      return new Response(up.body, { status: up.status, headers: out });
    } catch {
      return refuse(502, "The server's model proxy could not be reached");
    }
  }
}
