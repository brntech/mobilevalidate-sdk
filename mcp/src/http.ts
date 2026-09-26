// Streamable HTTP transport, stateless: a fresh server per request; the caller's Bearer key is forwarded to the API.
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { forwardFor, sdkFor } from "./client.ts";
import { buildServer, type Sdk } from "./tools.ts";
import { SERVER_CARD_HEADERS, SERVER_CARD_PATH, serverCardBody } from "./server-card.ts";
import { checkAgentKey, log } from "./util.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 50k numbers as JSON fit comfortably.

export interface HttpOptions {
  /** Extra Host headers accepted besides 127.0.0.1:<port> and localhost:<port> (DNS-rebinding protection). */
  allowedHosts?: string[];
  makeSdk?: (apiKey: string, ctx: { clientIp: string | null }) => Sdk;
  /**
   * Shared secret with the API (env MV_MCP_FORWARD_SECRET). When set, sandbox-key calls tell the API the end client's
   * IP so its per-IP sandbox limits apply per end client. Unset → nothing is forwarded.
   */
  forwardSecret?: string | null;
  /** Header with the end client's IP when the peer is loopback (a tunnel/proxy). Default cf-connecting-ip. */
  clientIpHeader?: string;
  /**
   * Edge secret (env MV_EDGE_SECRET, same value as the API's): the Cloudflare edge adds `x-mv-edge: <secret>` to every
   * request. The client-IP header is trusted only from loopback AND with a matching edge secret; unset → never trusted
   * (fail closed: every tunnelled caller then shares the loopback address, i.e. the strictest sandbox bucket).
   */
  edgeSecret?: string | null;
}

export const EDGE_HEADER = "x-mv-edge";

const isLoopback = (ip: string) => ip === "::1" || /^(::ffff:)?127\./.test(ip);

/** Constant-time check of the edge secret header; false when no secret is configured (fail closed). */
function edgeVerified(req: IncomingMessage, secret: string | null | undefined): boolean {
  if (!secret) return false;
  const raw = req.headers[EDGE_HEADER];
  const got = Buffer.from((Array.isArray(raw) ? raw[0] : raw) ?? ""), want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The end client's IP: the proxy's header only when the connection comes from loopback (tunnel) AND carries the edge
 * secret (other local users of this shared host can also reach loopback — security review L2), else the socket peer.
 */
function endClientIp(req: IncomingMessage, header: string, edgeSecret: string | null | undefined): string | null {
  const remote = req.socket.remoteAddress ?? null;
  if (remote && !isLoopback(remote)) return remote;
  if (!edgeVerified(req, edgeSecret)) return remote;
  const raw = req.headers[header];
  const fwd = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
  return fwd || remote;
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
}

/** Unauthenticated, cacheable Server Card (SEP-2127): GET/HEAD with ETag → 304, OPTIONS preflight. Any Host (public metadata). */
function serveServerCard(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") { res.writeHead(204, { ...SERVER_CARD_HEADERS, "access-control-max-age": "86400" }); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SERVER_CARD_HEADERS, allow: "GET, HEAD, OPTIONS" }); res.end(); return;
  }
  const { body, etag } = serverCardBody();
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").map((t) => t.trim().replace(/^W\//, "")).includes(etag)) {
    res.writeHead(304, { ...SERVER_CARD_HEADERS, etag }); res.end(); return;
  }
  res.writeHead(200, { ...SERVER_CARD_HEADERS, etag, "content-length": String(Buffer.byteLength(body)) });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

export function createHttpServer(opts: HttpOptions = {}): Server {
  const header = (opts.clientIpHeader ?? "cf-connecting-ip").toLowerCase();
  const makeSdk = opts.makeSdk ?? ((key: string, ctx: { clientIp: string | null }) => sdkFor(key, forwardFor(key, ctx.clientIp, opts.forwardSecret)));
  const hostAllowed = (host: string) => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || (opts.allowedHosts ?? []).includes(host);
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    if (path === SERVER_CARD_PATH) { serveServerCard(req, res); return; }
    if (path !== "/mcp") { jsonRpcError(res, 404, "Not found. The MCP endpoint is /mcp."); return; }
    if (!hostAllowed(req.headers.host ?? "")) { jsonRpcError(res, 403, "Host not allowed."); return; }
    if (req.method !== "POST") { jsonRpcError(res, 405, "Method not allowed (stateless server: POST only).", { allow: "POST" }); return; }

    const auth = req.headers.authorization ?? "";
    const key = checkAgentKey(/^Bearer\s+(.+)$/i.exec(auth)?.[1]);
    if (!key.ok) {
      jsonRpcError(res, 401, key.message, { "www-authenticate": 'Bearer realm="mobilevalidate"' });
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      jsonRpcError(res, (e as { status?: number }).status ?? 400, (e as Error).message);
      return;
    }

    const server = buildServer(makeSdk(key.key, { clientIp: endClientIp(req, header, opts.edgeSecret) }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("http request failed", { error: (e as Error).message });
      if (!res.headersSent) jsonRpcError(res, 500, "Internal error");
    }
  });
  return server;
}

/**
 * Start the HTTP server from env: MCP_HOST (default 127.0.0.1), MCP_PORT (3300), MCP_ALLOWED_HOSTS (comma-separated),
 * MV_MCP_FORWARD_SECRET (hosted deployment only; same value as the API's), MCP_CLIENT_IP_HEADER (cf-connecting-ip),
 * MV_EDGE_SECRET (hosted deployment only; same value as the API's — without it the client-IP header is never trusted).
 */
export function startHttpServerFromEnv(env: Record<string, string | undefined> = process.env): Server {
  const host = env.MCP_HOST ?? "127.0.0.1";
  const port = Number(env.MCP_PORT ?? 3300);
  const extra = (env.MCP_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return createHttpServer({ allowedHosts: extra, forwardSecret: env.MV_MCP_FORWARD_SECRET || null, clientIpHeader: env.MCP_CLIENT_IP_HEADER,
    edgeSecret: env.MV_EDGE_SECRET || null })
    .listen(port, host, () => log("http server listening", { url: `http://${host}:${port}/mcp` }));
}

// Run when executed directly (pnpm --filter @mobilevalidate/mcp start). The npm bin uses http-server.ts instead
// (a bin is a symlink, so argv[1] would not match this module's URL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startHttpServerFromEnv();
