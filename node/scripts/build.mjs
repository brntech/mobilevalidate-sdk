// Build the publishable output from src/ via tsc:
//   dist/*.js + *.d.ts          ESM (import), plus the CLI (dist/cli.js)
//   dist/cjs/*.cjs + *.d.cts    CommonJS (require) — library only, no CLI
// Works on Node >= 18, Bun and Deno. Source files import each other with ".ts" extensions (so Node 24 / tsx run src/
// directly inside the monorepo); tsc rewrites them in JavaScript (rewriteRelativeImportExtensions) but not in
// declarations, so declaration specifiers are patched here. Run: pnpm --filter ./packages/sdk run build
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkgDir, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(join(pkgDir, "package.json")).resolve("typescript/bin/tsc");
const run = (cfg) => execFileSync(process.execPath, [tsc, "-p", join(pkgDir, cfg)], { stdio: "inherit" });

// 1. ESM
run("tsconfig.build.json");
const REL_TS = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g;
for (const f of readdirSync(dist, { encoding: "utf8" })) {
  if (!f.endsWith(".d.ts")) continue;
  const p = join(dist, f);
  const src = readFileSync(p, "utf8");
  const out = src.replace(REL_TS, "$1$2.js$3");
  if (out !== src) writeFileSync(p, out);
}

// 2. CJS → dist/cjs with .cjs / .d.cts extensions (no nested package.json needed). tsc compiles a copy of src/ that sits
//    in a CommonJS package scope, so NodeNext emits require() (the CLI stays ESM-only).
const stage = join(pkgDir, ".cjs-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "src"), { recursive: true });
for (const f of readdirSync(join(pkgDir, "src"))) {
  if (f.endsWith(".ts") && f !== "cli.ts" && f !== "cli-core.ts") copyFileSync(join(pkgDir, "src", f), join(stage, "src", f));
}
writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "commonjs" }));
const base = JSON.parse(readFileSync(join(pkgDir, "tsconfig.build.json"), "utf8"));
writeFileSync(join(stage, "tsconfig.json"), JSON.stringify({
  extends: "../../../tsconfig.base.json",
  compilerOptions: { ...base.compilerOptions, rootDir: "src", outDir: join(dist, "cjs-tmp") },
  include: ["src"],
}));
try {
  run(join(".cjs-stage", "tsconfig.json"));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
const tmp = join(dist, "cjs-tmp");
const cjs = join(dist, "cjs");
mkdirSync(cjs, { recursive: true });
const REL_JS = /((?:require\(|from\s+|import\(\s*)["'])(\.{1,2}\/[^"']+?)\.(?:js|ts)(["'])/g;
for (const f of readdirSync(tmp, { encoding: "utf8" })) {
  const src = readFileSync(join(tmp, f), "utf8");
  if (f.endsWith(".d.ts")) writeFileSync(join(cjs, f.replace(/\.d\.ts$/, ".d.cts")), src.replace(REL_JS, "$1$2.cjs$3"));
  else if (f.endsWith(".js")) writeFileSync(join(cjs, f.replace(/\.js$/, ".cjs")), src.replace(REL_JS, "$1$2.cjs$3"));
}
rmSync(tmp, { recursive: true, force: true });

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const bins = pkg.publishConfig?.bin ?? {};
for (const rel of Object.values(bins)) chmodSync(join(pkgDir, rel), 0o755);
console.log(`built ${pkg.name}@${pkg.version} → dist/ (ESM) + dist/cjs/ (CJS)`);
