// MCP Server Card (SEP-2127, extension `io.modelcontextprotocol/server-card`; schema snapshot
// https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json, checked 2026-09-25 — re-check monthly,
// the extension is still experimental). Served unauthenticated at GET <streamable-http-url>/server-card
// (https://mcp.mobilevalidate.com/mcp/server-card) and mirrored by the website at /.well-known/mcp/server-card.json.
// Public metadata only: identity, remote endpoint, auth header, protocol versions. No tools, prices or internals.
// Complements 2026-07-28 `server/discover` (served on /mcp itself): the card is readable without a key and without MCP.
// Name/title/description/version stay identical to server.json (MCP Registry) — test/server-card.test.ts enforces it.
import { createHash } from "node:crypto";
import { PROTOCOL_VERSIONS, SERVER_VERSION } from "./tools.ts";

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const SERVER_CARD_PATH = "/mcp/server-card";

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title?: string;
  websiteUrl?: string;
  icons?: { src: string; mimeType?: string; sizes?: string[] }[];
  remotes?: {
    type: "streamable-http" | "sse";
    url: string;
    headers?: { name: string; description?: string; value?: string; isRequired?: boolean; isSecret?: boolean;
      variables?: Record<string, { description?: string; isRequired?: boolean; isSecret?: boolean; placeholder?: string }> }[];
    supportedProtocolVersions?: string[];
  }[];
  _meta?: Record<string, unknown>;
}

export function serverCard(opts: { mcpUrl?: string; siteUrl?: string } = {}): ServerCard {
  const site = (opts.siteUrl ?? "https://mobilevalidate.com").replace(/\/$/, "");
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: "com.mobilevalidate/mcp",
    version: SERVER_VERSION,
    title: "MobileValidate",
    description: "Check phone numbers (WhatsApp, Telegram, carrier, spam reputation) and e-mail addresses.",
    websiteUrl: `${site}/docs/mcp`,
    icons: [{ src: `${site}/logo-512.png`, mimeType: "image/png", sizes: ["512x512"] }],
    remotes: [{
      type: "streamable-http",
      url: opts.mcpUrl ?? "https://mcp.mobilevalidate.com/mcp",
      headers: [{
        name: "Authorization",
        description: "Bearer token: a MobileValidate agent key (mv_agent_…, scoped and spend-capped) or test key (mv_test_…). Live keys are rejected.",
        value: "Bearer {api_key}",
        isRequired: true,
        isSecret: true,
        variables: { api_key: { description: "MobileValidate agent key (mv_agent_…) or test key (mv_test_…).", isRequired: true, isSecret: true, placeholder: "mv_agent_..." } },
      }],
      supportedProtocolVersions: [...PROTOCOL_VERSIONS], // 2026-07-28 first, then the legacy revisions
    }],
    // Reverse-DNS namespaced; links only (no tool list, no prices — those live in the linked documents).
    _meta: {
      "com.mobilevalidate/links": {
        facts: `${site}/facts.json`,
        docs: `${site}/docs/mcp`,
        llms: `${site}/llms.txt`,
        openapi: `${site}/openapi.yaml`,
      },
    },
  };
}

/** Serialized card + strong ETag (hash of the body). */
export function serverCardBody(opts?: Parameters<typeof serverCard>[0]): { body: string; etag: string } {
  const body = `${JSON.stringify(serverCard(opts), null, 2)}\n`;
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}

/** Response headers per the extension's discovery.md (CORS for browser clients, 1 h cache, ETag). */
export const SERVER_CARD_HEADERS: Readonly<Record<string, string>> = {
  "content-type": `${SERVER_CARD_MEDIA_TYPE}; charset=utf-8`,
  "cache-control": "public, max-age=3600",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
  "x-content-type-options": "nosniff",
};
