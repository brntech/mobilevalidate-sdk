import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package metadata (publish readiness)", () => {
  it("VERSION (User-Agent, CLI --version) matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
  it("publishes only built output with zero runtime dependencies", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.publishConfig.bin).toEqual({ mobilevalidate: "./dist/cli.js" });
    expect(pkg.publishConfig.exports["."]).toEqual({
      import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
      require: { types: "./dist/cjs/index.d.cts", default: "./dist/cjs/index.cjs" },
    });
    expect(pkg.publishConfig.exports["./webhooks"].require).toMatchObject({ default: "./dist/cjs/webhooks.cjs" });
    expect(pkg.engines.node).toBe(">=18");
  });
});
