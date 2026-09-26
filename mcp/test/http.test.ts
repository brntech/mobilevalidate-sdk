import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import type { Sdk } from "../src/tools.ts";
import { SANDBOX_PUBLIC_KEY } from "mobilevalidate";

const money = (amount: string) => ({ amount, currency: "USD" });
const keysSeen: string[] = [];
const fakeSdk = {
  account: { get: async () => ({ data: { org_id: "org_1", balance: money("1"), reserved: money("0") }, error: null }) },
  limits: { get: async () => ({ data: {}, error: null }) },
} as unknown as Sdk;

let base = "";
const server = createHttpServer({ makeSdk: (k) => { keysSeen.push(k); return fakeSdk; } });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const post = (body: string, auth?: string, host?: string) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(auth ? { authorization: auth } : {}), ...(host ? { host } : {}),
  },
  body,
});

describe("Streamable HTTP transport", () => {
  it("rejects live keys and missing keys with 401 and a clear message", async () => {
    const live = await post(rpc("tools/list"), "Bearer mv_live_abcdef123");
    expect(live.status).toBe(401);
    expect(await live.text()).toMatch(/Live keys/);
    expect((await post(rpc("tools/list"))).status).toBe(401);
    expect(keysSeen).toHaveLength(0);
  });

  it("serves tools/list and tools/call statelessly and forwards the Bearer key", async () => {
    const list = await post(rpc("tools/list"), "Bearer mv_test_abcdef123");
    expect(list.status).toBe(200);
    const body = await list.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools).toHaveLength(9);
    const call = await post(rpc("tools/call", { name: "get_account", arguments: {} }), "Bearer mv_agent_xyz789");
    const res = await call.json() as { result: { structuredContent: { org_id: string } } };
    expect(res.result.structuredContent.org_id).toBe("org_1");
    expect(keysSeen).toContain("mv_agent_xyz789");
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/mcp`, { method: "POST", headers: { host: "evil.example:80", authorization: "Bearer mv_test_abc" } }, (res) => resolve(res.statusCode ?? 0));
      req.end(rpc("tools/list"));
    });
    expect(status).toBe(403);
  });

  it("rejects GET and unknown paths", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("hosted server: end-client IP forwarding for the public sandbox key", () => {
  const SECRET = "s".repeat(40);
  const seen: Record<string, string | undefined>[] = [];
  let api: import("node:http").Server;
  let prevBase: string | undefined;
  beforeAll(async () => {
    const { createServer } = await import("node:http");
    api = createServer((req, res) => {
      seen.push({ ip: req.headers["x-mv-client-ip"] as string | undefined, secret: req.headers["x-mv-forward-secret"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ org_id: "org_1", balance: money("1"), reserved: money("0") }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    prevBase = process.env.MOBILEVALIDATE_BASE_URL;
    process.env.MOBILEVALIDATE_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (prevBase === undefined) delete process.env.MOBILEVALIDATE_BASE_URL; else process.env.MOBILEVALIDATE_BASE_URL = prevBase;
    await new Promise<void>((r) => api.close(() => r()));
  });

  async function call(forwardSecret: string | null, key: string, clientIp?: string) {
    const mcp = createHttpServer({ forwardSecret });
    await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`,
          ...(clientIp ? { "cf-connecting-ip": clientIp } : {}) },
        body: rpc("tools/call", { name: "get_account", arguments: {} }),
      });
      expect(res.status).toBe(200);
      return seen.at(-1)!;
    } finally {
      await new Promise<void>((r) => mcp.close(() => r()));
    }
  }

  it("forwards the end client's IP with the shared secret for the sandbox key", async () => {
    expect(await call(SECRET, SANDBOX_PUBLIC_KEY, "2001:db8::7")).toEqual({ ip: "2001:db8::7", secret: SECRET });
  });
  it("sends nothing without a configured secret, for other keys, or without a client IP", async () => {
    expect(await call(null, SANDBOX_PUBLIC_KEY, "2001:db8::7")).toEqual({ ip: undefined, secret: undefined });
    expect(await call(SECRET, "mv_test_abcdef123", "2001:db8::7")).toEqual({ ip: undefined, secret: undefined });
  });
  it("falls back to the socket address when no client-IP header is present", async () => {
    expect(await call(SECRET, SANDBOX_PUBLIC_KEY)).toEqual({ ip: "127.0.0.1", secret: SECRET });
  });
});

describe("stdio transport", () => {
  it("refuses to start with a live key", () => {
    const entry = fileURLToPath(new URL("../src/stdio.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const r = spawnSync(tsx, [entry], { env: { ...process.env, MOBILEVALIDATE_API_KEY: "mv_live_abcdef123" }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Live keys/);
    expect(r.stderr).not.toContain("abcdef123");
  });
});
