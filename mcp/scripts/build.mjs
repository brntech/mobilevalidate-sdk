// Build the publishable output: dist/ = ESM JavaScript + .d.ts (Node >= 20), from src/ via tsc.
// Source files import each other with ".ts" extensions (so Node 24 / tsx run src/ directly inside the monorepo);
// tsc rewrites them to ".js" in JavaScript (rewriteRelativeImportExtensions) but not in declarations, so the
// declaration files are patched here. Run: pnpm --filter @mobilevalidate/mcp run build (build the SDK first: its dist/ types are used)
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkgDir, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(join(pkgDir, "package.json")).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.build.json")], { stdio: "inherit" });

const REL_TS = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g;
for (const f of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
  if (!f.endsWith(".d.ts")) continue;
  const p = join(dist, f);
  const src = readFileSync(p, "utf8");
  const out = src.replace(REL_TS, "$1$2.js$3");
  if (out !== src) writeFileSync(p, out);
}
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const bins = pkg.publishConfig?.bin ?? {};
for (const rel of Object.values(bins)) chmodSync(join(pkgDir, rel), 0o755);
console.log(`built ${pkg.name}@${pkg.version} → dist/`);
