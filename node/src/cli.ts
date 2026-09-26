#!/usr/bin/env node
// CLI entry (npm bin `mobilevalidate` → dist/cli.js, Node >= 20). In the monorepo src/cli.ts also runs directly on Node 24 /
// tsx (type stripping). Logic lives in cli-core.ts.
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { runCli } from "./cli-core.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const code = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, body) => pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), createWriteStream(p)),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
});
process.exitCode = code;
