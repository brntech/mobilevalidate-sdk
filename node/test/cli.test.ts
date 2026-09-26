import { describe, expect, it } from "vitest";
import { EXIT, extractIdentifiers, extractNumbers, parseCli, runCli, type CliIO } from "../src/cli-core.ts";
import { MobileValidate } from "../src/index.ts";
import { emailLookup, errorBody, lookup, mockFetch, multiLookup, servicesList, spamLookup } from "./helpers.ts";

const KEY = "mv_test_abcdefghijklmnopqrstuvwxyz0123abcdef";

function harness(replies: Parameters<typeof mockFetch>[0], opts: Partial<CliIO> = {}) {
  const m = mockFetch(replies);
  let out = "", err = "";
  const baseUrls: (string | undefined)[] = [];
  const io: CliIO = {
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    readStdin: async () => "",
    readFile: async () => "",
    env: { MOBILEVALIDATE_API_KEY: KEY, NO_COLOR: "1" },
    isTTY: false,
    createClient: (o) => {
      baseUrls.push(o.baseUrl);
      return new MobileValidate({ ...o, fetch: m.fetch, sleep: async () => {} });
    },
    ...opts,
  };
  return { io, calls: m.calls, out: () => out, err: () => err, baseUrls };
}

describe("CLI argument parsing", () => {
  it("parses commands, positionals and flags", () => {
    const p = parseCli(["check", "+447700900001", "-", "--country", "GB", "--json", "--max-age", "3600"]);
    expect(p.positionals).toEqual(["check", "+447700900001", "-"]);
    expect(p.values).toMatchObject({ country: "GB", json: true, "max-age": "3600" });
  });

  it("extracts numbers from text and CSV (named column)", () => {
    expect(extractNumbers("+447700900001\n\n +447700900002 , +447700900003\n")).toEqual(["+447700900001", "+447700900002", "+447700900003"]);
    expect(extractNumbers('name,phone\n"Ann","+447700900001"\nBob,+447700900002\n', true)).toEqual(["+447700900001", "+447700900002"]);
    expect(extractNumbers("+447700900001,x\n+447700900002,y", true)).toEqual(["+447700900001", "+447700900002"]);
  });

  it("unknown option → exit 2 with usage", async () => {
    const h = harness([]);
    expect(await runCli(["check", "+447700900001", "--bogus"], h.io)).toBe(EXIT.USAGE);
    expect(h.err()).toMatch(/Usage:/);
  });

  it("missing key → exit 2, and more than 100 numbers → exit 2", async () => {
    const h = harness([], { env: {} });
    expect(await runCli(["account"], h.io)).toBe(EXIT.USAGE);
    const h2 = harness([]);
    const many = Array.from({ length: 101 }, (_, i) => `+4477009${String(i).padStart(5, "0")}`);
    expect(await runCli(["check", ...many], h2.io)).toBe(EXIT.USAGE);
    expect(h2.calls).toHaveLength(0);
  });

  it("--base-url and env MOBILEVALIDATE_BASE_URL are honoured", async () => {
    const h = harness([{ status: 200, body: { org_id: "o", balance: { amount: "1", currency: "USD" }, reserved: { amount: "0", currency: "USD" } } }], {
      env: { MOBILEVALIDATE_API_KEY: KEY, MOBILEVALIDATE_BASE_URL: "http://127.0.0.1:3200" },
    });
    await runCli(["account"], h.io);
    expect(h.baseUrls).toEqual(["http://127.0.0.1:3200"]);
  });
});

describe("CLI output modes and exit codes", () => {
  it("piped check → NDJSON per result, exit 0 when conclusive", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }]);
    expect(await runCli(["check", "+447700900001"], h.io)).toBe(EXIT.OK);
    const lines = h.out().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).whatsapp.registered).toBe(true);
  });

  it("--json prints the whole lookup", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }]);
    await runCli(["check", "+447700900001", "--json"], h.io);
    expect(JSON.parse(h.out()).object).toBe("lookup");
  });

  it("TTY → table, and never prints the API key", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }], { isTTY: true });
    await runCli(["check", "+447700900001", "--api-key", KEY], h.io);
    expect(h.out()).toMatch(/NUMBER\s+WHATSAPP/);
    expect(h.out()).toMatch(/\+447700900001\s+registered\s+high/);
    expect(h.out() + h.err()).not.toContain(KEY);
  });

  it("unknown result → exit 3", async () => {
    const h = harness([{ status: 200, body: lookup("completed", null) }]);
    expect(await runCli(["check", "+447700900003"], h.io)).toBe(EXIT.PARTIAL);
  });

  it("API error → exit 1 with code and request id on stderr", async () => {
    const h = harness([{ status: 401, body: errorBody("unauthorized", 401, false) }]);
    expect(await runCli(["check", "+447700900001"], h.io)).toBe(EXIT.ERROR);
    expect(h.err()).toMatch(/^Error: unauthorized: .*\n[\s\S]*Request ID: req_err/);
    expect(h.err()).not.toContain(KEY);
  });

  it("reads numbers from stdin with -, sends --wait/--max-age/--country", async () => {
    const h = harness([{ status: 200, body: lookup("completed") }], { readStdin: async () => "07700900001\n07700900002\n" });
    await runCli(["check", "-", "--country", "gb", "--wait", "5", "--max-age", "3600"], h.io);
    expect(h.calls[0]!.body).toMatchObject({ numbers: ["07700900001", "07700900002"], default_country: "GB", wait: 5, max_age: 3600 });
  });

  it("job create --file csv, job get, job results --registered (NDJSON when piped)", async () => {
    const item = { input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid" };
    const job = { object: "job", id: "job_1", status: "queued", created_at: "x" };
    const h = harness([
      { status: 201, body: job },
      { status: 200, body: { ...job, status: "completed" } },
      { status: 200, body: { data: [item, item], has_more: false, next_cursor: null } },
    ], { readFile: async () => "phone\n+447700900001\n+447700900002\n" });
    expect(await runCli(["job", "create", "--file", "leads.csv"], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.body).toEqual({ numbers: ["+447700900001", "+447700900002"] });
    expect(await runCli(["job", "get", "job_1"], h.io)).toBe(EXIT.OK);
    expect(await runCli(["job", "results", "job_1", "--registered", "false"], h.io)).toBe(EXIT.OK);
    expect(h.calls[2]!.url.searchParams.get("registered")).toBe("false");
    const lines = h.out().trim().split("\n");
    expect(lines.slice(-2).map((l) => JSON.parse(l).input)).toEqual(["+447700900001", "+447700900001"]);
  });

  it("job results rejects a bad --registered value", async () => {
    const h = harness([]);
    expect(await runCli(["job", "results", "job_1", "--registered", "yes"], h.io)).toBe(EXIT.USAGE);
  });
});

describe("CLI multi-service checks and services", () => {
  it("--checks telegram,viber,carrier → one column per service, request carries checks", async () => {
    const h = harness([{ status: 200, body: multiLookup() }], { isTTY: true });
    expect(await runCli(["check", "+447700900001", "--checks", "telegram,viber,carrier"], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.body).toMatchObject({ checks: ["telegram", "viber", "carrier"] });
    expect(h.out()).toMatch(/NUMBER\s+TELEGRAM\s+VIBER\s+NETWORK\.CARRIER/);
    expect(h.out()).toMatch(/\+447700900001\s+registered\s+not registered\s+Test Carrier \/ mobile/);
    expect(h.out()).toMatch(/VIBER: 0 registered, 1 not registered/);
  });

  it("--checks spam → SPAM RISK and SPAM SCORE columns; non-conclusive rows show their status", async () => {
    const h = harness([{ status: 200, body: spamLookup() }], { isTTY: true });
    expect(await runCli(["check", "+447700900001", "+447700900002", "+447700900003", "+447700900005", "--checks", "spam"], h.io)).toBe(EXIT.PARTIAL); // unknown rows → partial
    expect(h.calls[0]!.body).toMatchObject({ checks: ["spam"] });
    const out = h.out();
    expect(out).toMatch(/NUMBER\s+SPAM RISK\s+SPAM SCORE\s+CONFIDENCE/);
    expect(out).toMatch(/\+447700900001\s+high\s+95\s/);
    expect(out).toMatch(/\+447700900002\s+no_reports\s+0\s/);
    expect(out).toMatch(/\+447700900003\s+unknown\s+-\s/);
    expect(out).toMatch(/\+447700900005\s+unsupported_country\s+-\s/);
  });

  it("carrier data is shown as data when registered is true (current servers)", async () => {
    const body = multiLookup();
    (body.results[0]!.checks["network.carrier"] as { registered: boolean | null }).registered = true;
    const h = harness([{ status: 200, body }], { isTTY: true });
    await runCli(["check", "+447700900001", "--checks", "telegram,viber,carrier"], h.io);
    expect(h.out()).toMatch(/Test Carrier \/ mobile/);
  });

  it("piped multi-check prints NDJSON items with the checks map", async () => {
    const h = harness([{ status: 200, body: multiLookup() }]);
    await runCli(["check", "+447700900001", "--checks", "telegram,viber"], h.io);
    expect(Object.keys(JSON.parse(h.out().trim()).checks)).toContain("viber.registered");
  });

  it("services → table (TTY) or NDJSON (piped)", async () => {
    const h = harness([{ status: 200, body: servicesList() }], { isTTY: true });
    expect(await runCli(["services"], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.url.pathname).toBe("/v1/services");
    expect(h.out()).toMatch(/signal\.registered\s+Signal\s+phone\s+boolean\s+bulk only\s+- \/ \$0\.0003/);
    expect(h.out()).toMatch(/no affiliation/);
    const p = harness([{ status: 200, body: servicesList() }]);
    await runCli(["services"], p.io);
    expect(p.out().trim().split("\n")).toHaveLength(3);
  });
});

describe("CLI check-email", () => {
  const T = (l: string) => `${l}@test.mobilevalidate.com`;
  it("extracts e-mails from text and CSV (email column, mixed first column)", () => {
    expect(extractIdentifiers(`${T("registered")}\n+447700900001, ${T("unknown")}\n`))
      .toEqual({ numbers: ["+447700900001"], emails: [T("registered"), T("unknown")] });
    expect(extractIdentifiers(`name,email,phone\nA,${T("registered")},+447700900001\nB,${T("x")},\n`, true))
      .toEqual({ numbers: ["+447700900001"], emails: [T("registered"), T("x")] });
  });
  it("sends emails + checks (default email), prints an EMAIL table", async () => {
    const h = harness([{ status: 200, body: emailLookup() }], { isTTY: true });
    expect(await runCli(["check-email", T("registered"), T("not-registered")], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.body).toMatchObject({ emails: [T("registered"), T("not-registered")], checks: ["email"] });
    expect(h.calls[0]!.body).not.toHaveProperty("numbers");
    expect(h.out()).toMatch(/EMAIL\s+EMAIL\.VALID/);
    expect(h.out()).toMatch(/registered@test\.mobilevalidate\.com\s+registered/);
    expect(h.out()).toMatch(/not-registered@test\.mobilevalidate\.com\s+not registered/);
  });
  it("invalid e-mail rows show their email_status and exit 3", async () => {
    const body = emailLookup();
    body.results.push({ kind: "email", input: "bad", email: null, email_status: "invalid_email", e164: null, country: null } as never);
    const h = harness([{ status: 200, body }], { isTTY: true });
    expect(await runCli(["check-email", T("registered"), "bad"], h.io)).toBe(EXIT.PARTIAL);
    expect(h.out()).toMatch(/bad\s+invalid_email/);
  });
  it("bulk-only checks (gmail) fall back to a job and print its rows", async () => {
    const job = { object: "job", id: "job_e", status: "running", created_at: "x" };
    const row = emailLookup().results[0]!;
    const h = harness([
      { status: 403, body: { error: { code: "service_disabled", message: "The check 'gmail.email' is available in bulk jobs only (POST /v1/jobs).", status: 403, retryable: false, param: "checks[1]", request_id: "req_x" } } },
      { status: 201, body: job },
      { status: 200, body: { ...job, status: "completed" } },
      { status: 200, body: { data: [row], has_more: false, next_cursor: null } },
    ]);
    expect(await runCli(["check-email", T("registered"), "--checks", "email,gmail"], h.io)).toBe(EXIT.OK);
    expect(h.calls[1]!.url.pathname).toBe("/v1/jobs");
    expect(h.calls[1]!.body).toEqual({ emails: [T("registered")], checks: ["email", "gmail"] });
    expect(h.calls[2]!.url.searchParams.get("wait")).toBeTruthy();
    expect(JSON.parse(h.out().trim()).email).toBe(T("registered"));
  });
  it("other errors are not retried as jobs; usage errors for no input", async () => {
    const h = harness([{ status: 403, body: errorBody("suspected_enumeration", 403, false) }]);
    expect(await runCli(["check-email", T("registered")], h.io)).toBe(EXIT.ERROR);
    expect(h.calls).toHaveLength(1);
    expect(await runCli(["check-email"], harness([]).io)).toBe(EXIT.USAGE);
  });
  it("job create --file with an email column sends emails", async () => {
    const h = harness([{ status: 201, body: { object: "job", id: "job_1", status: "queued", created_at: "x" } }],
      { readFile: async () => `email\n${T("registered")}\n` });
    expect(await runCli(["job", "create", "--file", "list.csv", "--checks", "gmail"], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.body).toEqual({ emails: [T("registered")], checks: ["gmail"] });
  });

  it("jobs download prints the file, or streams it to --output", async () => {
    const csv = "row_no,e164\r\n1,+447700900001\r\n";
    const hdr = { "content-type": "text/csv; charset=utf-8" };
    const h = harness([{ status: 200, raw: csv, headers: hdr }]);
    expect(await runCli(["jobs", "download", "job_1"], h.io)).toBe(EXIT.OK);
    expect(h.calls[0]!.url.pathname).toBe("/v1/jobs/job_1/download");
    expect(h.calls[0]!.url.searchParams.get("format")).toBe("csv");
    expect(h.out()).toBe(csv);

    const written: Record<string, string> = {};
    const h2 = harness([{ status: 200, raw: '{"row_no":1}\n', headers: { "content-type": "application/x-ndjson" } }], {
      isTTY: true,
      writeFile: async (path, body) => { written[path] = await new Response(body).text(); },
    });
    expect(await runCli(["jobs", "download", "job_1", "--format", "ndjson", "--output", "out.ndjson"], h2.io)).toBe(EXIT.OK);
    expect(h2.calls[0]!.url.searchParams.get("format")).toBe("ndjson");
    expect(written["out.ndjson"]).toBe('{"row_no":1}\n');
    expect(h2.out()).toContain("out.ndjson");

    await expect(runCli(["jobs", "download", "job_1", "--format", "xml"], harness([]).io)).resolves.toBe(EXIT.USAGE);
  });
});
