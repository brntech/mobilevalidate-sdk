import { describe, expect, it } from "vitest";
import { MobileValidate, MobileValidateError, VERSION } from "../src/index.ts";
import { client, emailLookup, errorBody, lookup, money, multiLookup, servicesList, spamLookup } from "./helpers.ts";
import type { CheckInput, ServiceCode, SpamAttributes } from "../src/index.ts";

describe("whatsapp.check", () => {
  it("returns data on 200 and sends the contract body + headers", async () => {
    const { mv, calls } = client([{ status: 200, body: lookup("completed") }]);
    const { data, error } = await mv.whatsapp.check("07700 900001", {
      defaultCountry: "GB", maxAge: "7d", maxCost: 0.05, metadata: { crm: "1" },
    });
    expect(error).toBeNull();
    expect(data!.results[0]!.whatsapp!.registered).toBe(true);
    expect(data!.results[0]!.whatsapp!.future_field).toBe("tolerated");
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/v1/lookup");
    expect(c.body).toEqual({
      numbers: ["07700 900001"], default_country: "GB", max_age: 604800, wait: 10,
      max_cost: money("0.05"), metadata: { crm: "1" },
    });
    expect(c.headers.authorization).toMatch(/^Bearer mv_test_/);
    expect(c.headers["user-agent"]).toBe(`mobilevalidate-sdk/${VERSION}`);
    expect(c.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("202 pending → long-polls GET /v1/lookups/{id}?wait until completed", async () => {
    const { mv, calls } = client([
      { status: 202, body: lookup("pending"), headers: { location: "/v1/lookups/lkp_1" } },
      { status: 200, body: lookup("pending") },
      { status: 200, body: lookup("completed") },
    ]);
    const { data } = await mv.whatsapp.check(["+447700900004"]);
    expect(data!.status).toBe("completed");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v1/lookup", "GET /v1/lookups/lkp_1", "GET /v1/lookups/lkp_1",
    ]);
    expect(Number(calls[1]!.url.searchParams.get("wait"))).toBeGreaterThan(0);
    expect(calls[1]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("returns the pending lookup when the wait budget is exhausted", async () => {
    const { mv, calls } = client([{ status: 202, body: lookup("pending") }]);
    const { data } = await mv.whatsapp.check("+447700900004", { waitTimeoutMs: 0 });
    expect(data!.status).toBe("pending");
    expect(calls).toHaveLength(1);
  });

  it("wait: 0 returns immediately without polling", async () => {
    const { mv, calls } = client([{ status: 202, body: lookup("pending") }]);
    const { data } = await mv.whatsapp.check("+447700900004", { wait: 0 });
    expect(data!.status).toBe("pending");
    expect(calls[0]!.body).toMatchObject({ wait: 0 });
    expect(calls).toHaveLength(1);
  });

  it("retries 429 honouring Retry-After and reuses the idempotency key", async () => {
    const { mv, calls, sleeps } = client([
      { status: 429, body: errorBody("rate_limited", 429, true), headers: { "retry-after": "2" } },
      { status: 200, body: lookup("completed") },
    ]);
    const { data, error } = await mv.whatsapp.check("+447700900001");
    expect(error).toBeNull();
    expect(data!.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
  });

  it("retries 5xx and network errors with jittered backoff, up to maxRetries", async () => {
    const { mv, calls, sleeps } = client([
      new TypeError("fetch failed"),
      { status: 503, body: errorBody("temporarily_unavailable", 503, true) },
      { status: 503, body: errorBody("temporarily_unavailable", 503, true) },
    ], { maxRetries: 2 });
    const { error } = await mv.whatsapp.check("+447700900001");
    expect(error!.code).toBe("temporarily_unavailable");
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    sleeps.forEach((s, i) => expect(s).toBeLessThanOrEqual(500 * 2 ** i));
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });

  it("does not retry non-retryable errors and exposes typed fields", async () => {
    const { mv, calls } = client([{ status: 402, body: { error: { ...errorBody("insufficient_balance", 402, false).error, param: "numbers" } } }]);
    const { data, error } = await mv.whatsapp.check("+447700900402");
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(MobileValidateError);
    expect(error).toMatchObject({ code: "insufficient_balance", status: 402, retryable: false, requestId: "req_err", param: "numbers" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the body says retryable: false even on 429", async () => {
    const { mv, calls } = client([{ status: 429, body: errorBody("spend_cap_reached", 429, false) }]);
    const { error } = await mv.whatsapp.check("+447700900001");
    expect(error!.code).toBe("spend_cap_reached");
    expect(calls).toHaveLength(1);
  });

  it("throwOnError throws MobileValidateError", async () => {
    const { mv } = client([{ status: 401, body: errorBody("unauthorized", 401, false) }], { throwOnError: true });
    await expect(mv.whatsapp.check("+447700900001")).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("rejects bad arguments as invalid_argument without calling the API", async () => {
    const { mv, calls } = client([]);
    const { error } = await mv.whatsapp.check("+447700900001", { maxAge: "forever" });
    expect(error!.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("reports missing_api_key", async () => {
    const mv = new MobileValidate({ apiKey: "", fetch: async () => new Response("{}") });
    const { error } = await mv.account.get();
    expect(error!.code).toBe("missing_api_key");
  });

  it("times out a hung request with code timeout", async () => {
    const hang = (_: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const mv = new MobileValidate({ apiKey: "mv_test_x", fetch: hang, timeoutMs: 20, maxRetries: 0 });
    const { error } = await mv.account.get();
    expect(error!.code).toBe("timeout");
  });
});

describe("jobs", () => {
  it("estimate/create map params to the contract", async () => {
    const { mv, calls } = client([
      { status: 200, body: { total: 2, valid: 2, billable_max: 2, max_cost: money("0.004") } },
      { status: 201, body: { object: "job", id: "job_1", status: "queued", created_at: "x" } },
    ]);
    const est = await mv.jobs.estimate({ numbers: ["a", "b"], checks: ["whatsapp"] });
    expect(est.data!.max_cost!.amount).toBe("0.004");
    const job = await mv.jobs.create({ numbers: ["a", "b"], maxCost: "1.00", defaultCountry: "GB" });
    expect(job.data!.id).toBe("job_1");
    expect(calls[0]!.url.pathname).toBe("/v1/jobs/estimate");
    expect(calls[1]!.body).toEqual({ numbers: ["a", "b"], max_cost: money("1.00"), default_country: "GB" });
  });

  it("results() iterates across cursor pages with filters", async () => {
    const item = (n: string) => ({ input: n, e164: n, country: "GB", number_status: "valid" });
    const { mv, calls } = client([
      { status: 200, body: { data: [item("1"), item("2")], has_more: true, next_cursor: "c2" } },
      { status: 200, body: { data: [item("3")], has_more: false, next_cursor: null } },
    ]);
    const seen: string[] = [];
    for await (const r of mv.jobs.results("job_1", { registered: null, limit: 2 })) seen.push(r.input);
    expect(seen).toEqual(["1", "2", "3"]);
    expect(calls[0]!.url.searchParams.get("registered")).toBe("null");
    expect(calls[1]!.url.searchParams.get("after")).toBe("c2");
  });

  it("get/download/cancel use the right routes", async () => {
    const job = { object: "job", id: "job_1", status: "running", created_at: "x" };
    const { mv, calls } = client([
      { status: 200, body: job },
      { status: 200, raw: '{"row_no":1}\n', headers: { "content-type": "application/x-ndjson" } },
      { status: 200, body: job },
    ]);
    await mv.jobs.get("job_1", { wait: 99 });
    await mv.jobs.download("job_1", { format: "ndjson" });
    await mv.jobs.cancel("job_1");
    expect(calls[0]!.url.searchParams.get("wait")).toBe("30");
    expect(calls[1]!.url.search).toBe("?format=ndjson");
    expect(calls[2]!.method).toBe("DELETE");
  });

  it("download() returns the streamed CSV / NDJSON file, not JSON", async () => {
    const csv = "row_no,input_masked,e164\r\n1,+44770*****01,+447700900001\r\n";
    const ndjson = '{"row_no":1,"e164":"+447700900001"}\n{"row_no":2,"e164":"+447700900002"}\n';
    const { mv, calls } = client([
      { status: 200, raw: csv, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="job_1.csv"', "x-request-id": "req_d" } },
      { status: 200, raw: ndjson, headers: { "content-type": "application/x-ndjson", "content-disposition": 'attachment; filename="job_1.ndjson"' } },
      { status: 404, body: errorBody("not_found", 404, false) },
    ]);
    const a = await mv.jobs.download("job_1");
    expect(a.error).toBeNull();
    expect(calls[0]!.url.searchParams.get("format")).toBe("csv");
    expect(calls[0]!.headers.accept).toBe("text/csv");
    expect(a.requestId).toBe("req_d");
    expect(a.data!.format).toBe("csv");
    expect(a.data!.filename).toBe("job_1.csv");
    expect(a.data!.contentType).toBe("text/csv; charset=utf-8");
    expect(await a.data!.text()).toBe(csv);

    const b = await mv.jobs.download("job_1", { format: "ndjson" });
    expect(calls[1]!.headers.accept).toBe("application/x-ndjson");
    const rows: unknown[] = [];
    for await (const row of b.data!.rows()) rows.push(row);
    expect(rows).toEqual([{ row_no: 1, e164: "+447700900001" }, { row_no: 2, e164: "+447700900002" }]);

    const c = await mv.jobs.download("job_1", { format: "ndjson" });
    expect(c.data).toBeNull();
    expect(c.error!.code).toBe("not_found");
  });

  it("download() body is a byte stream", async () => {
    const { mv } = client([{ status: 200, raw: "a,b\r\n", headers: { "content-type": "text/csv" } }]);
    const { data } = await mv.jobs.download("job_1", { format: "csv" });
    const chunks: Uint8Array[] = [];
    const reader = data!.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("a,b\r\n");
  });
});

describe("account, limits, usage, webhook endpoints", () => {
  it("hit the expected paths", async () => {
    const { mv, calls } = client([
      { status: 200, body: { org_id: "org_1", balance: money("5"), reserved: money("0") } },
      { status: 200, body: {} }, { status: 200, body: {} },
      { status: 201, body: { id: "we_1", url: "https://h", events: ["job.completed"] } },
      { status: 200, body: { data: [] } }, { status: 202, body: {} }, { status: 204 },
    ]);
    expect((await mv.account.get()).data!.balance.amount).toBe("5");
    await mv.limits.get();
    await mv.usage.get({ from: "2026-09-01", to: "2026-09-25", groupBy: "service" });
    await mv.webhookEndpoints.create({ url: "https://h", events: ["job.completed"] });
    await mv.webhookEndpoints.list();
    await mv.webhookEndpoints.test("we_1");
    const del = await mv.webhookEndpoints.delete("we_1");
    expect(del.error).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /v1/account", "GET /v1/limits", "GET /v1/usage?from=2026-09-01&to=2026-09-25&group_by=service",
      "POST /v1/webhook_endpoints", "GET /v1/webhook_endpoints", "POST /v1/webhook_endpoints/we_1/test",
      "DELETE /v1/webhook_endpoints/we_1",
    ]);
  });
});

describe("spam reputation", () => {
  it("lookup(numbers, { checks: ['spam'] }) keeps integer attributes as numbers", async () => {
    const { mv, calls } = client([{ status: 200, body: spamLookup() }]);
    const { data, error } = await mv.lookup(["+447700900001", "+447700900002"], { checks: ["spam"] });
    expect(error).toBeNull();
    expect(calls[0]!.body).toMatchObject({ checks: ["spam"] });
    const a = data!.results[0]!.checks!["number.spam"]!.attributes as SpamAttributes | null;
    expect(a!.risk_level).toBe("high");
    expect(a!.risk_score).toBe(95);
    expect(typeof a!.risk_score).toBe("number");
    const n = data!.results[1]!.checks!["number.spam"]!.attributes as SpamAttributes | null;
    expect(n).toMatchObject({ risk_level: "no_reports", risk_score: 0 });
    expect(data!.results[3]!.checks!["number.spam"]!.status).toBe("unsupported_country");
  });
});

describe("multi-service lookups and the catalog", () => {
  it("lookup() sends checks and exposes the per-service results + by_service", async () => {
    const { mv, calls } = client([{ status: 200, body: multiLookup() }]);
    const checks: CheckInput[] = ["telegram", "viber", "network.carrier"];
    const { data, error } = await mv.lookup("+447700900001", { checks });
    expect(error).toBeNull();
    expect(calls[0]!.url.pathname).toBe("/v1/lookup");
    expect(calls[0]!.body).toMatchObject({ numbers: ["+447700900001"], checks: ["telegram", "viber", "network.carrier"] });
    const item = data!.results[0]!;
    expect(item.checks?.["telegram.registered"]?.registered).toBe(true);
    expect(item.checks?.["network.carrier"]?.attributes).toEqual({ line_type: "mobile", carrier: "Test Carrier", country: "GB" });
    expect(data!.summary.by_service?.["viber.registered"]?.not_registered).toBe(1);
    const code: ServiceCode = "some.future_service"; // open union
    expect(code).toBeTruthy();
  });

  it("whatsapp.check() stays an alias of lookup()", async () => {
    const { mv, calls } = client([{ status: 200, body: lookup("completed") }]);
    await mv.whatsapp.check("+447700900001", { checks: ["whatsapp", "telegram"] });
    expect(calls[0]!.body).toMatchObject({ checks: ["whatsapp", "telegram"] });
  });

  it("services() lists the catalog", async () => {
    const { mv, calls } = client([{ status: 200, body: servicesList() }]);
    const { data } = await mv.services();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v1/services");
    expect(data!.data.find((s) => s.code === "signal.registered")).toMatchObject({ realtime: false, prices: { realtime: null } });
  });

  it("jobs.create/estimate pass checks; results pass the service filter", async () => {
    const { mv, calls } = client([
      { status: 200, body: { object: "estimate", checks: ["signal.registered"], checks_total: 2 } },
      { status: 200, body: { data: [], has_more: false, next_cursor: null } },
    ]);
    await mv.jobs.estimate({ numbers: ["+447700900001", "+447700900002"], checks: ["signal"] });
    expect(calls[0]!.body).toMatchObject({ checks: ["signal"] });
    await mv.jobs.resultsPage("job_1", { registered: true, service: "signal" });
    expect(calls[1]!.url.searchParams.get("service")).toBe("signal");
  });
});

describe("e-mail lookups and jobs", () => {
  it("lookup({ emails, checks }) sends emails without numbers and types e-mail rows", async () => {
    const { mv, calls } = client([{ status: 200, body: emailLookup() }]);
    const { data, error } = await mv.lookup({ emails: ["registered@test.mobilevalidate.com"], checks: ["email", "apple.email"], maxAge: "1h" });
    expect(error).toBeNull();
    expect(calls[0]!.body).toEqual({ emails: ["registered@test.mobilevalidate.com"], checks: ["email", "apple.email"], max_age: 3600, wait: 10 });
    const row = data!.results[0]!;
    expect(row.kind).toBe("email");
    expect(row.email).toBe("registered@test.mobilevalidate.com");
    expect(row.email_status).toBe("valid");
    expect(row.number_status).toBeUndefined();
    expect(row.checks?.["email.valid"]?.registered).toBe(true);
  });
  it("lookup({ numbers, emails }) sends both; empty input is rejected locally", async () => {
    const { mv, calls } = client([{ status: 200, body: emailLookup() }]);
    await mv.lookup({ numbers: ["+447700900001"], emails: ["registered@test.mobilevalidate.com"], checks: ["whatsapp", "email"] });
    expect(calls[0]!.body).toMatchObject({ numbers: ["+447700900001"], emails: ["registered@test.mobilevalidate.com"] });
    const r = await mv.lookup({ checks: ["email"] });
    expect(r.error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(1);
  });
  it("jobs.create/estimate pass emails", async () => {
    const job = { object: "job", id: "job_1", status: "queued", created_at: "x" };
    const { mv, calls } = client([{ status: 200, body: { object: "estimate" } }, { status: 201, body: job }]);
    await mv.jobs.estimate({ emails: ["a@example.com"], checks: ["gmail"] });
    await mv.jobs.create({ numbers: ["+447700900001"], emails: ["a@example.com"], checks: ["whatsapp", "gmail"] });
    expect(calls[0]!.body).toEqual({ emails: ["a@example.com"], checks: ["gmail"] });
    expect(calls[1]!.body).toEqual({ numbers: ["+447700900001"], emails: ["a@example.com"], checks: ["whatsapp", "gmail"] });
  });
});
