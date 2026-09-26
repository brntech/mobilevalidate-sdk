// stdio serving, dual-era (MCP spec "stdio: backward compatibility"): the connection's opening message picks the era.
// A 2026-07-28 client opens with `server/discover` (or any request carrying the per-request `_meta` envelope) and is
// served statelessly; a 2025-era client opens with `initialize` and the connection stays pinned to the negotiated
// legacy revision. Both are built from the same tool definitions (buildServer).
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildServer, type Sdk, type ToolOptions } from "./tools.ts";
import { log } from "./util.ts";

export interface StdioOptions extends ToolOptions {
  /** Custom transport (tests); default: this process's stdin/stdout. */
  transport?: StdioServerTransport;
}

export function serveStdioServer(sdk: Sdk, opts: StdioOptions = {}): { close(): Promise<void> } {
  const { transport, ...toolOpts } = opts;
  return serveStdio(() => buildServer(sdk, toolOpts), {
    ...(transport ? { transport } : {}),
    onerror: (e) => log("stdio error", { error: e.message }),
  });
}
