import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXIT, formatError, parseHeaderLines, runCli, type CliIO } from "../src/cli-core.ts";
import { MobileValidate, SANDBOX_PUBLIC_KEY, SandboxMagicOnlyError } from "../src/index.ts";
import { emailLookup, lookup, mockFetch } from "./helpers.ts";

const KEY = "mv_test_abcdefghijklmnopqrstuvwxyz0123abcdef";

function harness(replies: Parameters<typeof mockFetch>[0], opts: Partial<CliIO> = {}) {
  const m = mockFetch(replies);
  let out = "", err = "";
  const keys: (string | undefined)[] = [];
  const io: CliIO = {
    stdout: (s) => { out += s; }, stderr: (s) => { err += s; },
    readStdin: async () => "", readFile: async () => "",
    env: { MOBILEVALIDATE_API_KEY: KEY, NO_COLOR: "1" }, isTTY: false,
    createClient: (o) => { keys.push(o.apiKey); return new MobileValidate({ ...o, fetch: m.fetch, sleep: async () => {} }); },
    ...opts,
  };
  return { io, calls: m.calls, out: () => out, err: () => err, keys };
}

const job = (status: string) => ({ object: "job", id: "job_1", status, created_at: "2026-09-25T10:00:00Z",
  progress: { total: 2, done: status === "completed" ? 2 : 0, conclusive: 2, non_billable: 0 } });

describe("CLI --sandbox and key hints", () => {
  it("--sandbox uses the public sandbox key and ignores the env key", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }], { env: { MOBILEVALIDATE_API_KEY: "mv_live_other" } });
    expect(await runCli(["check", "+447700900001", "--sandbox"], h.io)).toBe(EXIT.OK);
    expect(h.keys).toEqual([SANDBOX_PUBLIC_KEY]);
  });

  it("no key → usage error that points to --sandbox and the test-key page", async () => {
    const h = harness([], { env: {} });
    expect(await runCli(["services"], h.io)).toBe(EXIT.USAGE);
    expect(h.err()).toMatch(/--sandbox/);
    expect(h.err()).toMatch(/get-test-key/);
  });

  it("prints the API suggestion, docs link and request id on their own lines", async () => {
    const h = harness([{ status: 403, body: { error: { code: "sandbox_magic_only", message: "The sandbox key only answers test values.",
      status: 403, retryable: false, param: "numbers", suggestion: "Use +447700900001, or get a test key at mobilevalidate.com/get-test-key.",
      doc_url: "https://mobilevalidate.com/docs/errors#sandbox_magic_only", request_id: "req_sb" } } }]);
    expect(await runCli(["check", "+447700900001", "--sandbox"], h.io)).toBe(EXIT.ERROR);
    expect(h.err()).toContain("Error: sandbox_magic_only: The sandbox key only answers test values.\n");
    expect(h.err()).toContain("  Suggestion: Use +447700900001, or get a test key");
    expect(h.err()).toContain("  Docs: https://mobilevalidate.com/docs/errors#sandbox_magic_only");
    expect(h.err()).toContain("  Request ID: req_sb");
    expect(formatError(new SandboxMagicOnlyError({ code: "sandbox_magic_only", message: "m" }))).toBe("Error: sandbox_magic_only: m\n");
  });
});

describe("CLI check with numbers and e-mails", () => {
  it("splits positionals into numbers and emails with default checks per kind", async () => {
    const h = harness([{ status: 200, body: emailLookup() }]);
    await runCli(["check", "+447700900001", "registered@test.mobilevalidate.com"], h.io);
    expect(h.calls[0]!.body).toMatchObject({
      numbers: ["+447700900001"], emails: ["registered@test.mobilevalidate.com"], checks: ["whatsapp", "email"],
    });
  });

  it("prints row hints (suggestion) under the table", async () => {
    const body = lookup("completed");
    body.results.push({ input: "7700900001", e164: null, country: null, number_status: "invalid_number", suggestion: "Add the country code, e.g. +44 7700 900001." } as never);
    const h = harness([{ status: 200, body }], { isTTY: true });
    expect(await runCli(["check", "+447700900001", "7700900001"], h.io)).toBe(EXIT.PARTIAL);
    expect(h.out()).toMatch(/Hints:\n  7700900001: Add the country code/);
  });

  it("colours verdicts in a TTY unless NO_COLOR / --no-color", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }], { isTTY: true, env: { MOBILEVALIDATE_API_KEY: KEY } });
    await runCli(["check", "+447700900001"], h.io);
    expect(h.out()).toContain("\x1b[32mregistered");
    const h2 = harness([{ status: 200, body: lookup("completed") }], { isTTY: true, env: { MOBILEVALIDATE_API_KEY: KEY } });
    await runCli(["check", "+447700900001", "--no-color"], h2.io);
    expect(h2.out()).not.toContain("\x1b[");
  });
});

describe("CLI jobs create --wait", () => {
  const csv = "name,phone\nAnn,+447700900001\nBob,+447700900002\n";
  const rows = { object: "list", has_more: false, next_cursor: null, data: [
    { input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid", checks: { "whatsapp.registered": { service: "whatsapp.registered", status: "completed", registered: true, attributes: null, confidence: "high", confidence_score: 0.9, checked_at: null, cached: false, age_seconds: 0, billed: false, reason: null, poll_after_ms: null } } },
  ] };

  it("bare --wait waits for the job, then prints its results", async () => {
    const h = harness([
      { status: 201, body: job("queued") },
      { status: 200, body: job("running") },
      { status: 200, body: job("completed") },
      { status: 200, body: rows },
    ], { readFile: async () => csv, isTTY: true });
    expect(await runCli(["jobs", "create", "--file", "list.csv", "--wait"], h.io)).toBe(EXIT.OK);
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v1/jobs", "GET /v1/jobs/job_1", "GET /v1/jobs/job_1", "GET /v1/jobs/job_1/results",
    ]);
    expect(h.calls[0]!.body).toMatchObject({ numbers: ["+447700900001", "+447700900002"] });
    expect(h.out()).toMatch(/NUMBER\s+WHATSAPP/);
    expect(h.err()).toMatch(/waiting up to 600 s/);
  });

  it("--wait N with --json prints { job, results }; without --wait only creates", async () => {
    const h = harness([{ status: 201, body: job("completed") }, { status: 200, body: job("completed") }, { status: 200, body: rows }], { readFile: async () => csv });
    expect(await runCli(["jobs", "create", "--file", "list.csv", "--wait", "30", "--json"], h.io)).toBe(EXIT.OK);
    expect(JSON.parse(h.out())).toMatchObject({ job: { id: "job_1" }, results: [{ e164: "+447700900001" }] });
    const h2 = harness([{ status: 201, body: job("queued") }], { readFile: async () => csv });
    expect(await runCli(["job", "create", "--file", "list.csv"], h2.io)).toBe(EXIT.OK);
    expect(h2.calls).toHaveLength(1);
  });
});

describe("CLI webhooks", () => {
  const secret = "whsec_" + Buffer.from("cli-test-secret-0123456789abcdef").toString("base64");
  const body = JSON.stringify({ type: "job.completed", id: "evt_9", created_at: "2026-09-25T10:00:00Z", data: { object: "job", id: "job_1" } });
  const now = 1_790_000_000;
  const sig = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`msg_9.${now}.${body}`).digest("base64");

  it("verify: valid signature → exit 0 without any API key or request", async () => {
    const h = harness([], { env: {}, readFile: async () => body, now: () => now });
    const code = await runCli(["webhooks", "verify", "--secret", secret, "--file", "body.json", "--id", "msg_9", "--timestamp", String(now), "--signature", sig], h.io);
    expect(code).toBe(EXIT.OK);
    expect(h.out()).toMatch(/Signature valid\. Event job\.completed \(evt_9\)/);
    expect(h.calls).toHaveLength(0);
  });

  it("verify: headers file + env secret; tampered body → exit 1 with a hint", async () => {
    const files: Record<string, string> = { "h.txt": `webhook-id: msg_9\nWebhook-Timestamp: ${now}\nwebhook-signature: ${sig}\n`, "b.json": body.replace("job_1", "job_2") };
    const h = harness([], { env: { MOBILEVALIDATE_WEBHOOK_SECRET: secret }, readFile: async (p) => files[p]!, now: () => now });
    expect(await runCli(["webhooks", "verify", "--file", "b.json", "--headers", "h.txt"], h.io)).toBe(EXIT.ERROR);
    expect(h.err()).toMatch(/Signature INVALID: No matching signature/);
    expect(h.err()).toMatch(/raw body/);
  });

  it("sign prints headers that verify accepts", async () => {
    const h = harness([], { env: {}, readFile: async () => body, now: () => now });
    await runCli(["webhooks", "sign", "--secret", secret, "--file", "b.json", "--id", "msg_9", "--json"], h.io);
    const headers = JSON.parse(h.out());
    expect(headers).toEqual({ "webhook-id": "msg_9", "webhook-timestamp": String(now), "webhook-signature": sig });
    expect(parseHeaderLines("A: 1\nb:  two \n")).toEqual({ a: "1", b: "two" });
  });

  it("list and test call the API", async () => {
    const h = harness([
      { status: 200, body: { object: "list", has_more: false, data: [{ id: "we_1", url: "https://example.com/hook", events: ["job.completed"], status: "active" }] } },
      { status: 202, body: { queued: true } },
    ], { isTTY: true });
    expect(await runCli(["webhooks", "list"], h.io)).toBe(EXIT.OK);
    expect(await runCli(["webhooks", "test", "we_1"], h.io)).toBe(EXIT.OK);
    expect(h.out()).toMatch(/we_1\s+https:\/\/example\.com\/hook/);
    expect(h.calls[1]!.url.pathname).toBe("/v1/webhook_endpoints/we_1/test");
  });
});
