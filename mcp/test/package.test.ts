import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/tools.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const pkg = read("../package.json");
const serverJson = read("../server.json");

describe("package metadata (publish readiness)", () => {
  it("SERVER_VERSION matches package.json and server.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version });
  });
  it("mcpName matches the MCP Registry server name (npm ownership check)", () => {
    expect(pkg.mcpName).toBe(serverJson.name);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
  it("publishes built output only; bins point to dist", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "server.json"]);
    expect(pkg.publishConfig.bin).toEqual({ "mobilevalidate-mcp": "./dist/stdio.js", "mobilevalidate-mcp-http": "./dist/http-server.js" });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/server", "mobilevalidate", "zod"]);
  });
});
