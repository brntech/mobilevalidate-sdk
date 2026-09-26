import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.ts";
import { SERVER_CARD_MEDIA_TYPE, serverCard } from "../src/server-card.ts";
import { validate } from "./json-schema-lite.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
// Snapshot of https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json
// (modelcontextprotocol/experimental-ext-server-card schema.json, fetched 2026-09-25).
const schema = read("./fixtures/server-card.schema.json");
const serverJson = read("../server.json");

describe("MCP Server Card (SEP-2127)", () => {
  it("validates against the Server Card JSON Schema snapshot", () => {
    const card = serverCard();
    expect(validate({ $ref: "#/$defs/ServerCard" }, card, schema)).toEqual([]);
    expect(card.description.length).toBeLessThanOrEqual(100);
  });

  it("matches the MCP Registry server.json identity and remote", () => {
    const card = serverCard();
    expect(card).toMatchObject({ name: serverJson.name, title: serverJson.title, description: serverJson.description, version: serverJson.version });
    expect(card.remotes?.[0]?.url).toBe(serverJson.remotes[0].url);
    expect(card.remotes?.[0]?.type).toBe("streamable-http");
    expect(card.remotes?.[0]?.supportedProtocolVersions?.length).toBeGreaterThan(0);
  });

  it("carries no tool list, prices or internal hosts", () => {
    const text = JSON.stringify(serverCard());
    expect(text).not.toMatch(/"tools"|price|127\.0\.0\.1|localhost|\$\d/i);
  });
});

describe("GET /mcp/server-card", () => {
  const server = createHttpServer({ makeSdk: () => { throw new Error("no SDK needed"); } });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("serves the card without auth, with CORS, cache headers and an ETag (304 on If-None-Match)", async () => {
    const res = await fetch(`${base}/mcp/server-card`, { headers: { accept: SERVER_CARD_MEDIA_TYPE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/mcp-server-card\+json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await res.json()).toEqual(serverCard());
    const again = await fetch(`${base}/mcp/server-card`, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    const head = await fetch(`${base}/mcp/server-card`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers CORS preflight and rejects writes", async () => {
    const pre = await fetch(`${base}/mcp/server-card`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
    expect((await fetch(`${base}/mcp/server-card`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("serves the card for the public Host too (no DNS-rebinding risk for static metadata)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/mcp/server-card`, { headers: { host: "mcp.mobilevalidate.com" } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(200);
  });
});
