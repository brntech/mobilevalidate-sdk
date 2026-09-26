// Runs every recipe's tests.
//   node test/run.mjs          offline: against the mock API in test/mock-api.mjs (default)
//   LIVE=1 node test/run.mjs   against https://api.mobilevalidate.com with the public sandbox key
//                              (set MOBILEVALIDATE_TEST_KEY=mv_test_… to also run the personal-test-key cases)
// In the MobileValidate monorepo it builds and packs the local SDKs first; in a standalone copy of this repo it uses
// the published packages (npm install / pip install -r requirements.txt).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockApi } from "./mock-api.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(root);
const LIVE = process.env.LIVE === "1";
const inMonorepo = existsSync(join(repo, "packages/sdk/package.json")) && existsSync(join(repo, "packages/sdk-python/pyproject.toml"));
// Async: the mock API runs in this process, so the event loop must stay free while the suites run.
const run = (cmd, args, opts) => new Promise((resolve) => spawn(cmd, args, { stdio: "inherit", ...opts }).on("close", (code) => resolve(code ?? 1)));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n==> ${s}`);

// 1. Node dependencies: express (Express recipe) + the SDK as a real packed package (never src/).
step("Node dependencies");
if (!existsSync(join(root, "node_modules/express"))) sh("npm", ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "express@^5.1.0"], { cwd: root });
if (inMonorepo && !process.env.SKIP_SDK_BUILD) {
  sh("pnpm", ["--filter", "mobilevalidate", "run", "build"], { cwd: repo });
  const tmp = mkdtempSync(join(tmpdir(), "mv-examples-"));
  const out = execFileSync("pnpm", ["pack", "--pack-destination", tmp], { cwd: join(repo, "packages/sdk"), encoding: "utf8" });
  const tgz = out.trim().split("\n").filter((l) => l.endsWith(".tgz")).pop();
  const dest = join(root, "node_modules/mobilevalidate");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  sh("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"]);
  rmSync(tmp, { recursive: true, force: true });
} else if (!existsSync(join(root, "node_modules/mobilevalidate"))) {
  sh("npm", ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "mobilevalidate@^1.0.0"], { cwd: root });
}

// 2. Python: a git-ignored venv with the SDK, Flask and pytest.
step("Python venv (.venv)");
const py = join(root, ".venv/bin/python");
if (!existsSync(py)) sh("python3", ["-m", "venv", join(root, ".venv")]);
const sdkReq = inMonorepo ? ["-e", join(repo, "packages/sdk-python")] : ["mobilevalidate-sdk>=1.0,<2"];
sh(py, ["-m", "pip", "install", "-q", ...sdkReq, "flask>=3.0", "pytest>=8"]);

// 3. API: the offline mock, or the real API with the sandbox key.
const api = LIVE ? null : await startMockApi();
const env = { ...process.env };
delete env.MOBILEVALIDATE_API_KEY; // recipes fall back to the public sandbox key
if (api) env.MOBILEVALIDATE_BASE_URL = api.url;
else delete env.MOBILEVALIDATE_BASE_URL;
step(LIVE ? "API: https://api.mobilevalidate.com (sandbox key)" : `API: mock at ${api.url}`);

const nodeTests = [
  "otp-signup-guard/express/otp-decision.test.mjs",
  "otp-signup-guard/express/server.test.mjs",
  "otp-signup-guard/nextjs/test/route.test.ts",
  "choose-channel/choose-channel.test.mjs",
  "email-signup-check/email-check.test.mjs",
  "webhook-receiver/node/server.test.mjs",
];
const pyTests = ["csv-list-cleaner", "webhook-receiver/python", "email-signup-check"];

let failed = 0;
step("Node recipes (node --test)");
failed += (await run(process.execPath, ["--test", "--test-reporter=spec", ...nodeTests], { cwd: root, env })) ? 1 : 0;
step("Python recipes (pytest)");
failed += (await run(py, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "--import-mode=importlib", ...pyTests], { cwd: root, env })) ? 1 : 0;

await api?.close();
console.log(failed ? "\nSOME TESTS FAILED" : "\nAll example tests passed.");
process.exit(failed ? 1 : 0);
