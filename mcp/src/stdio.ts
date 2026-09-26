#!/usr/bin/env node
// Local stdio transport: the key comes from env MOBILEVALIDATE_API_KEY (never from arguments).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sdkFor } from "./client.ts";
import { buildServer } from "./tools.ts";
import { checkAgentKey, log } from "./util.ts";

const key = checkAgentKey(process.env.MOBILEVALIDATE_API_KEY);
if (!key.ok) {
  process.stderr.write(`[mobilevalidate-mcp] ${key.message}\n`);
  process.exit(1);
}
const server = buildServer(sdkFor(key.key));
await server.connect(new StdioServerTransport());
log("stdio server ready", { mode: key.key.startsWith("mv_test_") ? "test" : "agent" });
