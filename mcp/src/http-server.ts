#!/usr/bin/env node
// npm bin `mobilevalidate-mcp-http`: Streamable HTTP transport (stateless, POST /mcp). Each request brings its own
// `Authorization: Bearer mv_agent_…|mv_test_…` key. Env: MCP_HOST, MCP_PORT, MCP_ALLOWED_HOSTS, MOBILEVALIDATE_BASE_URL.
import { startHttpServerFromEnv } from "./http.ts";

startHttpServerFromEnv();
