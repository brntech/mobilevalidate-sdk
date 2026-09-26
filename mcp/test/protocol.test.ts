// MCP protocol revisions: the server speaks 2026-07-28 (stateless, per-request `_meta`, server/discover) and
// the 2025-era initialize revisions, on both transports. Real clients on each side:
//   - legacy: @modelcontextprotocol/sdk 1.30.0 Client (2025-11-25 initialize handshake; dev dependency only);
//   - modern: @modelcontextprotocol/client 2.0.0 Client with versionNegotiation (server/discover, 2026-07-28 envelope).
// Both clients validate structuredContent against each tool's outputSchema, so every call below also checks that.
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import { serveStdioServer } from "../src/stdio-server.ts";
import { MODERN_PROTOCOL_VERSION, PROTOCOL_VERSIONS, SERVER_VERSION, type Sdk } from "../src/tools.ts";
import { serverCard } from "../src/server-card.ts";
import { mockSdk } from "./mock-sdk.ts";

const TOOLS = ["normalize_numbers", "estimate_cost", "lookup_numbers", "lookup_emails", "check_spam_reputation", "create_lookup_job",
  "get_lookup_job", "list_services", "get_account"];

/** One valid call per tool (mock SDK: 2 numbers, $0.0024, below the $1 confirmation threshold). */
const CALLS: Record<string, Record<string, unknown>> = {
  normalize_numbers: { numbers: ["+447700900001", "07700900002"], default_country: "GB" },
  estimate_cost: { numbers: ["+447700900001", "+447700900003"], checks: ["whatsapp"] },
  lookup_numbers: { numbers: ["+447700900001", "+447700900003"] },
  lookup_emails: { emails: ["registered@test.mobilevalidate.com", "unknown@test.mobilevalidate.com"] },
  check_spam_reputation: { numbers: ["+447700900001", "+447700900003"] },
  create_lookup_job: { numbers: ["+447700900001", "+447700900003"] },
  get_lookup_job: { job_id: "job_1", limit: 10 },
  list_services: {},
  get_account: {},
};

type AnyClient = {
  listTools(): Promise<{ tools: { name: string; outputSchema?: unknown; annotations?: unknown }[] }>;
  callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
  getServerVersion(): { name: string; version: string } | undefined;
  close(): Promise<void>;
};
type Era = "legacy" | "modern";

async function exerciseEveryTool(client: AnyClient) {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(TOOLS); // deterministic order (2026-07-28 SHOULD)
  for (const t of tools) {
    expect(t.outputSchema, t.name).toBeTruthy();
    expect(t.annotations, t.name).toBeTruthy();
    const r = await client.callTool({ name: t.name, arguments: CALLS[t.name]! });
    expect(r.isError, `${t.name}: ${JSON.stringify(r.content)}`).toBeFalsy();
    expect(r.structuredContent, t.name).toBeTypeOf("object");
    expect((r.content as { type: string; text: string }[])[0]!.text.length, t.name).toBeGreaterThan(0);
  }
}

/**
 * Safety rules must not depend on the protocol revision. Threshold $0.001 (MCP_CONFIRM_ABOVE_USD): the $0.0024 lookup
 * needs the user's confirmation; once confirmed it runs with max_cost = the confirmed amount; metadata is never echoed.
 */
async function checkSafety(client: AnyClient, sdk: ReturnType<typeof mockSdk>) {
  const args = { numbers: ["+447700900001", "+447700900003"] };
  sdk.lookup.mockClear();
  const gated = await client.callTool({ name: "lookup_numbers", arguments: args });
  expect(gated.isError).toBe(true);
  expect((gated.structuredContent as { error: { code: string } }).error.code).toBe("confirmation_required");
  expect(sdk.lookup).not.toHaveBeenCalled();
  const ok = await client.callTool({ name: "lookup_numbers", arguments: { ...args, confirm_max_cost: "0.0024" } });
  expect(ok.isError).toBeFalsy();
  expect(sdk.lookup).toHaveBeenCalledWith(args.numbers, expect.objectContaining({ maxCost: "0.0024" }));
  expect(JSON.stringify(ok)).not.toContain("do-not-echo");
}

// ---------------------------------------------------------------------------------------------------------------
describe("Streamable HTTP: protocol negotiation", () => {
  const sdk = mockSdk();
  const server = createHttpServer({ makeSdk: () => sdk as unknown as Sdk });
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const auth = { headers: { authorization: "Bearer mv_test_abcdef123" } };

  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer mv_test_abcdef123", ...headers },
    body: JSON.stringify(body),
  });
  const envelope = (v = MODERN_PROTOCOL_VERSION) => ({
    "io.modelcontextprotocol/protocolVersion": v,
    "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  });
  const modernHeaders = (method: string, name?: string, v = MODERN_PROTOCOL_VERSION) =>
    ({ "mcp-protocol-version": v, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });

  it("old-revision client (2025-11-25 initialize handshake) negotiates 2025-11-25 and uses every tool", async () => {
    const client = new LegacyClient({ name: "legacy-test", version: "0" });
    const transport = new LegacyHttp(new URL(url), { requestInit: auth });
    await client.connect(transport);
    expect(transport.protocolVersion ?? "2025-11-25").toBe("2025-11-25");
    expect(client.getServerVersion()).toMatchObject({ name: "mobilevalidate", version: SERVER_VERSION });
    await exerciseEveryTool(client as unknown as AnyClient);
    await client.close();
  });

  it("older initialize revisions are still accepted (2025-06-18, 2025-03-26, 2024-11-05)", async () => {
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
      expect(res.status, v).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/); // unchanged: JSON, no session id
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const body = await res.json() as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion, v).toBe(v);
    }
  });

  it("new-revision client (2026-07-28, server/discover probe) negotiates 2026-07-28 and uses every tool", async () => {
    for (const mode of ["auto", { pin: MODERN_PROTOCOL_VERSION }] as const) {
      const client = new ModernClient({ name: "modern-test", version: "0" }, { versionNegotiation: { mode } });
      await client.connect(new ModernHttp(new URL(url), { requestInit: auth }));
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
      expect(client.getServerVersion()).toMatchObject({ name: "mobilevalidate", version: SERVER_VERSION });
      expect(client.getDiscoverResult()?.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);
      expect(client.getInstructions()).toMatch(/Only check numbers your user has a legitimate relationship with/);
      await exerciseEveryTool(client as unknown as AnyClient);
      await client.close();
    }
  });

  it("server/discover: versions, identity, capabilities and public cache hints", async () => {
    const res = await post({ jsonrpc: "2.0", id: "d1", method: "server/discover", params: { _meta: envelope() } }, modernHeaders("server/discover"));
    expect(res.status).toBe(200);
    const { result } = await res.json() as { result: Record<string, any> };
    expect(result).toMatchObject({ resultType: "complete", supportedVersions: [MODERN_PROTOCOL_VERSION], ttlMs: 3_600_000, cacheScope: "public" });
    expect(result.capabilities.tools).toBeTruthy();
    expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "mobilevalidate", version: SERVER_VERSION });
    // Advertised revisions = the server card's list (modern first, then the initialize revisions).
    expect(PROTOCOL_VERSIONS[0]).toBe(result.supportedVersions[0]);
    expect(serverCard().remotes?.[0]?.supportedProtocolVersions).toEqual([...PROTOCOL_VERSIONS]);
  });

  it("tools/list on 2026-07-28 carries resultType and a public 1 h cache hint", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() } }, modernHeaders("tools/list"));
    const { result } = await res.json() as { result: { resultType: string; ttlMs: number; cacheScope: string; tools: { name: string }[] } };
    expect(result).toMatchObject({ resultType: "complete", ttlMs: 3_600_000, cacheScope: "public" });
    expect(result.tools.map((t) => t.name)).toEqual(TOOLS);
  });

  it("unsupported revision → 400 UnsupportedProtocolVersion (-32022) listing 2026-07-28", async () => {
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: envelope("2099-01-01") } }, modernHeaders("tools/list", undefined, "2099-01-01"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: number; data: { supported: string[]; requested: string } } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain(MODERN_PROTOCOL_VERSION);
    expect(body.error.data.requested).toBe("2099-01-01");
  });

  it("2026-07-28 header validation: Mcp-Name must match the body (HeaderMismatch -32020)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_account", arguments: {}, _meta: envelope() } },
      modernHeaders("tools/call", "list_services"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: number } }).error.code).toBe(-32020);
  });

  it("key rules apply before any protocol handling, in both eras", async () => {
    const live = await post({ jsonrpc: "2.0", id: 5, method: "server/discover", params: { _meta: envelope() } },
      { ...modernHeaders("server/discover"), authorization: "Bearer mv_live_abcdef123" });
    expect(live.status).toBe(401);
    expect(await live.text()).toMatch(/Live keys/);
  });

  it("spend confirmation and metadata rules hold on 2026-07-28 and 2025-11-25", async () => {
    const gatedSdk = mockSdk("0.0024");
    process.env.MCP_CONFIRM_ABOVE_USD = "0.001"; // read by buildServer on every request
    try {
      const modern = new ModernClient({ name: "m", version: "0" }, { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } });
      const gated = createHttpServer({ makeSdk: () => gatedSdk as unknown as Sdk });
      await new Promise<void>((r) => gated.listen(0, "127.0.0.1", r));
      const gUrl = new URL(`http://127.0.0.1:${(gated.address() as AddressInfo).port}/mcp`);
      try {
        await modern.connect(new ModernHttp(gUrl, { requestInit: auth }));
        await checkSafety(modern as unknown as AnyClient, gatedSdk);
        await modern.close();
        const legacy = new LegacyClient({ name: "l", version: "0" });
        await legacy.connect(new LegacyHttp(gUrl, { requestInit: auth }));
        await checkSafety(legacy as unknown as AnyClient, gatedSdk);
        await legacy.close();
      } finally {
        await new Promise<void>((r) => gated.close(() => r()));
      }
    } finally {
      delete process.env.MCP_CONFIRM_ABOVE_USD;
    }
  });

  it("2025-era session operations stay refused (stateless server): GET → 405", async () => {
    expect((await fetch(url, { headers: { authorization: "Bearer mv_test_abcdef123" } })).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** Newline-delimited JSON-RPC client transport over in-process streams (the stdio wire format). */
class PipeClientTransport {
  onmessage?: (m: unknown) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private buf = "";
  private readonly toServer: PassThrough;
  private readonly fromServer: PassThrough;
  constructor(toServer: PassThrough, fromServer: PassThrough) { this.toServer = toServer; this.fromServer = fromServer; }
  async start() {
    this.fromServer.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line));
      }
    });
  }
  async send(m: unknown) { this.toServer.write(`${JSON.stringify(m)}\n`); }
  async close() { this.onclose?.(); }
}

function inProcessStdio(sdk: ReturnType<typeof mockSdk>) {
  const toServer = new PassThrough(), fromServer = new PassThrough();
  const handle = serveStdioServer(sdk as unknown as Sdk, { transport: new StdioServerTransport(toServer, fromServer), confirmAboveUsd: "1.00" });
  return { transport: new PipeClientTransport(toServer, fromServer), close: () => handle.close() };
}

describe("stdio: protocol negotiation (in-process, stdio wire format)", () => {
  it("old-revision client negotiates 2025-11-25 and uses every tool", async () => {
    const pipe = inProcessStdio(mockSdk());
    const client = new LegacyClient({ name: "legacy-stdio", version: "0" });
    await client.connect(pipe.transport as never);
    expect(client.getServerVersion()).toMatchObject({ name: "mobilevalidate", version: SERVER_VERSION });
    await exerciseEveryTool(client as unknown as AnyClient);
    await client.close();
    await pipe.close();
  });

  it("new-revision client negotiates 2026-07-28 and uses every tool", async () => {
    const pipe = inProcessStdio(mockSdk());
    const client = new ModernClient({ name: "modern-stdio", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(pipe.transport as never);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
    expect(client.getDiscoverResult()?.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);
    await exerciseEveryTool(client as unknown as AnyClient);
    await client.close();
    await pipe.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("stdio binary (mobilevalidate-mcp): both revisions against a stub API", () => {
  let api: HttpServer;
  let apiUrl = "";
  beforeAll(async () => {
    api = createHttp((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ org_id: "org_stub", balance: { amount: "1", currency: "USD" }, reserved: { amount: "0", currency: "USD" } }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => api.close(() => r())));

  const params = () => ({
    command: fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
    args: [fileURLToPath(new URL("../src/stdio.ts", import.meta.url))],
    env: { PATH: process.env.PATH ?? "", MOBILEVALIDATE_API_KEY: "mv_test_abcdef123", MOBILEVALIDATE_BASE_URL: apiUrl, MCP_LOG: "off" },
    stderr: "ignore" as const,
  });

  async function smoke(client: AnyClient, era: Era) {
    expect(client.getServerVersion(), era).toMatchObject({ name: "mobilevalidate", version: SERVER_VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    const r = await client.callTool({ name: "get_account", arguments: {} });
    expect((r.structuredContent as { org_id: string }).org_id).toBe("org_stub");
  }

  it("2025-11-25 client", async () => {
    const client = new LegacyClient({ name: "legacy-bin", version: "0" });
    await client.connect(new LegacyStdio(params()));
    await smoke(client as unknown as AnyClient, "legacy");
    await client.close();
  }, 30_000);

  it("2026-07-28 client (server/discover probe on a sibling process, then modern requests)", async () => {
    const client = new ModernClient({ name: "modern-bin", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new ModernStdio(params()));
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
    await smoke(client as unknown as AnyClient, "modern");
    await client.close();
  }, 30_000);
});
