#!/usr/bin/env node
// Local stdio transport: the key comes from env MOBILEVALIDATE_API_KEY (never from arguments).
// Serves MCP 2026-07-28 and the 2025-era revisions (see stdio-server.ts).
import { sdkFor } from "./client.ts";
import { serveStdioServer } from "./stdio-server.ts";
import { checkAgentKey, log } from "./util.ts";

const key = checkAgentKey(process.env.MOBILEVALIDATE_API_KEY);
if (!key.ok) {
  process.stderr.write(`[mobilevalidate-mcp] ${key.message}\n`);
  process.exit(1);
}
serveStdioServer(sdkFor(key.key));
log("stdio server ready", { mode: key.key.startsWith("mv_test_") ? "test" : "agent" });
