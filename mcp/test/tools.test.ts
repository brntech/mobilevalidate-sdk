import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MobileValidateError, type Estimate, type Lookup } from "mobilevalidate";
import { lookup, mockSdk } from "./mock-sdk.ts";
import { describe, expect, it, vi } from "vitest";
import { buildServer, type Sdk } from "../src/tools.ts";
import { log } from "../src/util.ts";

const money = (amount: string) => ({ amount, currency: "USD" });

async function connect(sdk: ReturnType<typeof mockSdk>, confirmAboveUsd = "1.00") {
  const server = buildServer(sdk as unknown as Sdk, { confirmAboveUsd });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const nums = (n: number) => Array.from({ length: n }, (_, i) => `+4477009${String(i + 10).padStart(5, "0")}`);

describe("tool catalog", () => {
  it("exposes exactly the 9 tools with titles, annotations, input and output schemas", async () => {
    const client = await connect(mockSdk());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "normalize_numbers", "estimate_cost", "lookup_numbers", "lookup_emails", "check_spam_reputation", "create_lookup_job",
      "get_lookup_job", "list_services", "get_account",
    ]);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[hint], `${t.name}.${hint}`).toBe("boolean");
      }
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/webhook|metadata/);
    }
    const lookupTool = tools.find((t) => t.name === "lookup_numbers")!;
    expect(lookupTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect((lookupTool.inputSchema.properties as Record<string, { maxItems?: number }>).numbers!.maxItems).toBe(100);
  });
});

describe("normalize_numbers", () => {
  it("normalizes locally and flags ambiguous inputs without calling the API", async () => {
    const sdk = mockSdk();
    const client = await connect(sdk);
    const r = await client.callTool({ name: "normalize_numbers", arguments: { numbers: ["+44 7700 900001", "07700900002", "7700900003", "abc"], default_country: "GB" } });
    const out = r.structuredContent as { results: { e164: string | null; status: string }[] };
    expect(out.results.map((x) => [x.e164, x.status])).toEqual([
      ["+447700900001", "valid"], ["+447700900002", "valid"], ["+447700900003", "valid"], [null, "invalid"],
    ]);
    const r2 = await client.callTool({ name: "normalize_numbers", arguments: { numbers: ["07700900002"] } });
    expect((r2.structuredContent as { results: { status: string }[] }).results[0]!.status).toBe("ambiguous");
    expect(sdk.jobs.estimate).not.toHaveBeenCalled();
  });
});

describe("lookup_numbers", () => {
  it("below the threshold: estimates, then checks with max_cost = estimate; never echoes metadata", async () => {
    const sdk = mockSdk("0.0024");
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: ["+447700900001", "+447700900003"] } });
    expect(r.isError).toBeFalsy();
    expect(sdk.lookup).toHaveBeenCalledWith(["+447700900001", "+447700900003"], expect.objectContaining({ maxCost: "0.0024", wait: 20 }));
    const out = r.structuredContent as { results: { registered: boolean | null; check_status: string }[]; summary: { unknown: number } };
    expect(out.results.map((x) => x.registered)).toEqual([true, null]);
    expect(out.summary.unknown).toBe(1);
    expect(JSON.stringify(r)).not.toContain("do-not-echo");
    expect(JSON.stringify(r)).not.toContain("metadata");
  });

  it("above the threshold: returns confirmation_required and does not spend", async () => {
    const sdk = mockSdk("3.20");
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(5) } });
    expect(r.isError).toBe(true);
    const err = (r.structuredContent as { error: { code: string; max_cost: { amount: string } } }).error;
    expect(err.code).toBe("confirmation_required");
    expect(err.max_cost.amount).toBe("3.2");
    expect((r.content as { text: string }[])[0]!.text).toMatch(/USER.*confirm_max_cost: "3.2"/s);
    expect(sdk.lookup).not.toHaveBeenCalled();
  });

  it("proceeds when confirm_max_cost covers the estimate and caps spend at the confirmed amount", async () => {
    const sdk = mockSdk("3.20");
    const client = await connect(sdk);
    const low = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(5), confirm_max_cost: "3.00" } });
    expect((low.structuredContent as { error: { code: string } }).error.code).toBe("confirmation_required");
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(5), confirm_max_cost: "3.20" } });
    expect(r.isError).toBeFalsy();
    expect(sdk.lookup).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxCost: "3.20" }));
  });

  it("quotes and caps real-time lookups at REAL-TIME prices, not the bulk estimate", async () => {
    // Bulk estimate: 4 × $0.0003 = $0.0012; real time: 4 × $0.0005 = $0.002.
    const sdk = mockSdk();
    sdk.jobs.estimate.mockResolvedValue({ data: { total: 4, valid: 4, invalid: 0, duplicate: 0, cached: 0, unsupported: 0, suppressed: 0,
      billable_max: 4, max_cost: money("0.0012"), checks: ["telegram.registered"] }, error: null });
    const client = await connect(sdk, "0.0015");
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(4), checks: ["telegram"] } });
    const err = (r.structuredContent as { error: { code: string; max_cost: { amount: string } } }).error;
    expect(err.code).toBe("confirmation_required");
    expect(err.max_cost.amount).toBe("0.002");
    expect(sdk.lookup).not.toHaveBeenCalled();
    const ok = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(4), checks: ["telegram"], confirm_max_cost: "0.002" } });
    expect(ok.isError).toBeFalsy();
    expect(sdk.lookup).toHaveBeenCalledWith(nums(4), expect.objectContaining({ maxCost: "0.002" }));
    const high = await connect(sdk);
    await high.callTool({ name: "lookup_numbers", arguments: { numbers: nums(4), checks: ["telegram"] } });
    expect(sdk.lookup).toHaveBeenLastCalledWith(nums(4), expect.objectContaining({ maxCost: "0.002" }));
  });

  it("numbers + e-mails: each kind at its own real-time prices", async () => {
    const sdk = mockSdk();
    const est = (valid: number, checks: string[]) => ({ data: { total: valid, valid, invalid: 0, duplicate: 0, cached: 0, unsupported: 0,
      suppressed: 0, billable_max: valid * checks.length, max_cost: money("0.0001"), checks }, error: null });
    sdk.jobs.estimate.mockImplementation((async (p: { numbers?: string[]; emails?: string[] }) =>
      p.emails ? est(3, ["telegram.registered", "email.valid"]) : est(2, ["telegram.registered"])) as never);
    const client = await connect(sdk);
    await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(2), emails: ["registered@test.mobilevalidate.com"], checks: ["telegram", "email"] } });
    // 2 numbers × $0.0005 + 1 e-mail × $0.002
    expect(sdk.lookup).toHaveBeenCalledWith(expect.objectContaining({ maxCost: "0.003" }));
    expect(sdk.jobs.estimate).toHaveBeenLastCalledWith(expect.objectContaining({ numbers: nums(2), emails: undefined, checks: ["telegram.registered"] }));
  });

  it("test keys (nothing billable) are never asked to confirm", async () => {
    const sdk = mockSdk();
    sdk.jobs.estimate.mockResolvedValue({ data: { total: 5, valid: 5, invalid: 0, duplicate: 0, cached: 0, unsupported: 0, suppressed: 0,
      billable_max: 0, max_cost: money("0"), checks: ["whatsapp.registered"] }, error: null });
    const client = await connect(sdk, "0.0001");
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(5) } });
    expect(r.isError).toBeFalsy();
    expect(sdk.lookup).toHaveBeenCalledWith(nums(5), expect.objectContaining({ maxCost: "0" }));
  });

  it("maps API errors to actionable tool errors", async () => {
    const sdk = mockSdk();
    sdk.lookup.mockResolvedValueOnce({ data: null, error: new MobileValidateError({ code: "insufficient_balance", message: "Not enough credit", status: 402 }) } as never);
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: ["+447700900402"] } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("insufficient_balance");
    expect((r.content as { text: string }[])[0]!.text).toMatch(/top up/);
  });

  it("rejects more than 100 numbers via input validation", async () => {
    const client = await connect(mockSdk());
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(101) } });
    expect(r.isError).toBe(true);
  });
});

describe("create_lookup_job", () => {
  it("requires confirmation above 100 numbers even when cheap", async () => {
    const sdk = mockSdk("0.05", 150);
    const client = await connect(sdk);
    const r = await client.callTool({ name: "create_lookup_job", arguments: { numbers: nums(150) } });
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("confirmation_required");
    expect(sdk.jobs.create).not.toHaveBeenCalled();
    const ok = await client.callTool({ name: "create_lookup_job", arguments: { numbers: nums(150), confirm_max_cost: "0.05" } });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { job_id: string }).job_id).toBe("job_1");
    const params = (sdk.jobs.create.mock.calls[0] as unknown as [{ maxCost: string; idempotencyKey: string }])[0];
    expect(params.maxCost).toBe("0.05");
    expect(params.idempotencyKey).toMatch(/^mcp-job-[0-9a-f]+$/);
  });
});

describe("get_lookup_job and get_account", () => {
  it("returns job progress with a filtered page of results", async () => {
    const sdk = mockSdk();
    const client = await connect(sdk);
    const r = await client.callTool({ name: "get_lookup_job", arguments: { job_id: "job_1", registered: "null", limit: 10 } });
    expect(sdk.jobs.resultsPage).toHaveBeenCalledWith("job_1", { registered: "null", after: undefined, limit: 10 });
    await client.callTool({ name: "get_lookup_job", arguments: { job_id: "job_1", registered: "true", service: "signal" } });
    expect(sdk.jobs.resultsPage).toHaveBeenLastCalledWith("job_1", { registered: "true", after: undefined, limit: 50, service: "signal" });
    expect(r.structuredContent).toMatchObject({ job_id: "job_1", status: "running", has_more: true, next_cursor: "c2" });
  });

  it("returns balance and limits", async () => {
    const client = await connect(mockSdk());
    const r = await client.callTool({ name: "get_account", arguments: {} });
    expect(r.structuredContent).toMatchObject({ org_id: "org_1", balance: { amount: "10.00" }, limits: { requests_per_second: 10 } });
  });
});

function multi(): Lookup {
  const c = (service: string, registered: boolean | null, attributes: Record<string, string | boolean | number> | null = null) => ({
    service, status: "completed", registered, attributes, confidence: "high", confidence_score: 0.95, checked_at: "2026-09-25T10:00:00Z",
    cached: false, age_seconds: 0, billed: false, reason: null, poll_after_ms: null });
  return {
    ...lookup(),
    results: [{ input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid", test: true,
      checks: { "telegram.registered": c("telegram.registered", true), "network.carrier": c("network.carrier", null, { carrier: "Test Carrier", line_type: "mobile" }) } }],
    summary: { total: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0, invalid: 0, suppressed: 0, by_service: {
      "telegram.registered": { completed: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0 },
      "network.carrier": { completed: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0 } } },
  };
}

describe("multi-service checks", () => {
  it("checks are forwarded and every service's result is returned", async () => {
    const sdk = mockSdk();
    sdk.lookup.mockResolvedValueOnce({ data: multi(), error: null });
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: ["+447700900001"], checks: ["telegram", "carrier"] } });
    expect(r.isError).toBeFalsy();
    expect(sdk.jobs.estimate).toHaveBeenCalledWith(expect.objectContaining({ checks: ["telegram", "carrier"] }));
    expect(sdk.lookup).toHaveBeenCalledWith(["+447700900001"], expect.objectContaining({ checks: ["telegram", "carrier"] }));
    const item = (r.structuredContent as { results: { registered: boolean | null; checks: Record<string, { registered: boolean | null; attributes: unknown }> }[] }).results[0]!;
    expect(item.registered).toBe(true); // first service when WhatsApp was not requested
    expect(item.checks["network.carrier"]!.attributes).toEqual({ carrier: "Test Carrier", line_type: "mobile" });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/telegram\.registered 1 registered/);
  });

  it("list_services returns the key's catalog split into real time / bulk only", async () => {
    const sdk = mockSdk();
    const client = await connect(sdk);
    const r = await client.callTool({ name: "list_services", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ realtime: ["whatsapp.registered", "email.valid", "telegram.registered"], bulk_only: ["signal.registered"] });
    const svc = (r.structuredContent as { services: { code: string; price_realtime: unknown }[] }).services;
    expect(svc.find((x) => x.code === "signal.registered")!.price_realtime).toBeNull();
  });

  it("descriptions list the services, bulk-only ones and the anti-enumeration limits", async () => {
    const client = await connect(mockSdk());
    const { tools } = await client.listTools();
    const lookupTool = tools.find((t) => t.name === "lookup_numbers")!;
    expect(lookupTool.description).toMatch(/Bulk-only services \(.*signal\.registered/);
    expect(lookupTool.description).toMatch(/consecutive numbers .* refused/);
    const checksDesc = (lookupTool.inputSchema.properties as Record<string, { description?: string }>).checks!.description!;
    expect(checksDesc).toMatch(/telegram\.registered/);
    expect(checksDesc).toMatch(/Bulk only \(use create_lookup_job\): .*signal\.registered/);
    expect(tools.find((t) => t.name === "create_lookup_job")!.description).toMatch(/consecutive numbers/);
  });

  it("service_disabled for a bulk-only service points the agent to create_lookup_job", async () => {
    const sdk = mockSdk();
    sdk.lookup.mockResolvedValueOnce({ data: null, error: new MobileValidateError({ code: "service_disabled", message: "The check 'signal.registered' is available in bulk jobs only (POST /v1/jobs)", status: 403 }) });
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: ["+447700900001"], checks: ["signal"] } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/create_lookup_job/);
  });
});

function emailResult(): Lookup {
  const c = (registered: boolean | null) => ({ service: "email.valid", status: registered === null ? "unknown" : "completed", registered,
    attributes: null, confidence: registered === null ? null : "high", confidence_score: null, checked_at: "2026-09-25T10:00:00Z",
    cached: false, age_seconds: 0, billed: false, reason: registered === null ? "UNSUPPORTED_PROVIDER" : null, poll_after_ms: null });
  return {
    ...lookup(),
    results: [
      { kind: "email", input: "registered@test.mobilevalidate.com", email: "registered@test.mobilevalidate.com", email_status: "valid",
        e164: null, country: null, test: true, checks: { "email.valid": c(true) } },
      { kind: "email", input: "nope", email: null, email_status: "invalid_email", e164: null, country: null, test: true },
    ],
    summary: { total: 2, registered: 1, not_registered: 0, unknown: 0, pending: 0, invalid: 1, suppressed: 0,
      by_service: { "email.valid": { completed: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0 } } },
  };
}

describe("e-mail checks", () => {
  const T = (l: string) => `${l}@test.mobilevalidate.com`;
  it("lookup_emails defaults to the email check, forwards emails only and returns e-mail rows", async () => {
    const sdk = mockSdk();
    sdk.lookup.mockResolvedValueOnce({ data: emailResult(), error: null });
    sdk.jobs.estimate.mockResolvedValue({ data: { total: 2, valid: 1, invalid: 1, duplicate: 0, cached: 0, unsupported: 0, suppressed: 0,
      billable_max: 1, max_cost: money("0.001"), checks: ["email.valid"] }, error: null });
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_emails", arguments: { emails: [T("registered"), "nope"] } });
    expect(r.isError).toBeFalsy();
    expect(sdk.jobs.estimate).toHaveBeenCalledWith(expect.objectContaining({ emails: [T("registered"), "nope"], checks: ["email"], numbers: undefined }));
    // 1 valid e-mail × the real-time email.valid price ($0.002), not the bulk estimate ($0.001)
    expect(sdk.lookup).toHaveBeenCalledWith(expect.objectContaining({ emails: [T("registered"), "nope"], checks: ["email"], maxCost: "0.002" }));
    const out = r.structuredContent as { results: Record<string, unknown>[] };
    expect(out.results[0]).toMatchObject({ kind: "email", email: T("registered"), email_status: "valid", e164: null, number_status: null, registered: true });
    expect(out.results[1]).toMatchObject({ kind: "email", email: null, email_status: "invalid_email", registered: null });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/2 checked: 1 registered/);
  });
  it("lookup_numbers and create_lookup_job accept numbers + emails together", async () => {
    const sdk = mockSdk();
    const client = await connect(sdk);
    await client.callTool({ name: "lookup_numbers", arguments: { numbers: ["+447700900001"], emails: [T("registered")], checks: ["whatsapp", "email"] } });
    expect(sdk.lookup).toHaveBeenCalledWith(expect.objectContaining({ numbers: ["+447700900001"], emails: [T("registered")] }));
    const j = await client.callTool({ name: "create_lookup_job", arguments: { emails: [T("registered")], checks: ["gmail"] } });
    expect(j.isError).toBeFalsy();
    expect(sdk.jobs.create).toHaveBeenCalledWith(expect.objectContaining({ emails: [T("registered")], numbers: undefined, checks: ["gmail"] }));
    const e = await client.callTool({ name: "estimate_cost", arguments: { emails: [T("a"), T("b")], checks: ["gmail"] } });
    expect(e.isError).toBeFalsy();
  });
  it("estimate_cost lists checks priced at the real-time price because their part is too small", async () => {
    const sdk = mockSdk("0.0006", 2);
    sdk.jobs.estimate.mockResolvedValueOnce({ data: { total: 2, valid: 2, invalid: 0, duplicate: 0, cached: 0, unsupported: 0, suppressed: 0,
      billable_max: 2, max_cost: money("0.006"), checks: ["whatsapp.registered"], breakdown: [
        { check: "whatsapp.registered", price_mode: "batch", reason: null, checks: 0, unit_price: money("0.00015"), max_cost: money("0") },
        { check: "whatsapp.registered", price_mode: "realtime", reason: "small_batch", checks: 2, unit_price: money("0.003"),
          max_cost: money("0.006"), countries: ["DE"], batch_minimum: 132 }] }, error: null });
    const client = await connect(sdk);
    const e = await client.callTool({ name: "estimate_cost", arguments: { numbers: nums(2), checks: ["whatsapp"] } });
    expect(e.isError).toBeFalsy();
    expect((e.structuredContent as { small_batch: unknown[] }).small_batch).toEqual([
      { check: "whatsapp.registered", checks: 2, unit_price: money("0.003"), countries: ["DE"], batch_minimum: 132 }]);
    expect(JSON.stringify(e.content)).toContain("fewer than 132 numbers per country");
  });
  it("no identifiers → invalid_request without calling the API; > 100 together → too_many_numbers", async () => {
    const sdk = mockSdk();
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { checks: ["email"] } });
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("invalid_request");
    const many = await client.callTool({ name: "lookup_numbers", arguments: { numbers: nums(60), emails: Array.from({ length: 41 }, (_, i) => T(`u${i}x`)) } });
    expect((many.structuredContent as { error: { code: string } }).error.code).toBe("too_many_numbers");
    expect(sdk.jobs.estimate).not.toHaveBeenCalled();
  });
  it("descriptions state the e-mail anti-enumeration rule and privacy (no names/profiles)", async () => {
    const client = await connect(mockSdk());
    const { tools } = await client.listTools();
    for (const name of ["lookup_emails", "lookup_numbers", "create_lookup_job"]) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d, name).toMatch(/never names, photos, profiles/);
      expect(d, name).toMatch(/differ only by digits .* refused/);
    }
    const le = tools.find((t) => t.name === "lookup_emails")!;
    expect(le.description).toMatch(/Bulk-only e-mail services \(.*gmail\.email/);
    const checksDesc = (tools.find((t) => t.name === "lookup_numbers")!.inputSchema.properties as Record<string, { description?: string }>).checks!.description!;
    expect(checksDesc).toMatch(/E-mail services \(for emails\)/);
  });
  it("enumeration refusal is explained to the agent", async () => {
    const sdk = mockSdk();
    sdk.jobs.estimate.mockResolvedValueOnce({ data: null, error: new MobileValidateError({ code: "suspected_enumeration", message: "The request looks like a generated list of e-mail addresses", status: 403 }) } as never);
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_emails", arguments: { emails: [T("a1")] } });
    expect((r.content as { text: string }[])[0]!.text).toMatch(/legitimately holds/);
  });
  it("the stderr logger masks e-mail addresses", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => { writes.push(s); return true; };
    try { log("x", { who: "john.doe@example.com" }); } finally { (process.stderr as { write: unknown }).write = orig; }
    expect(writes.join("")).not.toContain("john.doe@example.com");
    expect(writes.join("")).toContain("jo•••@example.com");
  });
});

/** number.spam lookup as the API returns it (test magic …001 high, …002 no_reports, …003 unknown, …005 unsupported, bad). */
function spamLookup(): Lookup {
  const base = { service: "number.spam", confidence: "high", confidence_score: 0.99, checked_at: "2026-09-25T10:00:00Z", cached: false,
    age_seconds: 0, billed: false, reason: null, poll_after_ms: null };
  const na = (status: string, reason: string) => ({ ...base, status, registered: null, attributes: null, confidence: null,
    confidence_score: null, checked_at: null, age_seconds: null, reason });
  const row = (n: string, c: object | null, number_status = "valid") => ({ input: n, e164: c ? n : null, country: c ? "GB" : null,
    number_status, test: true, ...(c ? { checks: { "number.spam": c } } : {}) });
  return {
    object: "lookup", id: "lkp_s", status: "completed", livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [
      row("+447700900001", { ...base, status: "completed", registered: true, attributes: { risk_level: "high", risk_score: 95,
        reason_regulator: true, reason_government: false, reason_community: true, reason_unassigned: false, voip_range: false,
        top_category: "robocall", first_seen: "2025-11", last_seen: "2026-08", sources: 2 } }),
      row("+447700900002", { ...base, status: "completed", registered: true, attributes: { risk_level: "no_reports", risk_score: 0,
        reason_regulator: false, reason_government: false, reason_community: false, reason_unassigned: false, voip_range: false, sources: 0 } }),
      row("+447700900003", na("unknown", "UPSTREAM_TIMEOUT")),
      row("+447700900005", na("unsupported_country", "UNSUPPORTED_COUNTRY")),
      row("bad", null, "invalid_number"),
    ],
    summary: { total: 5, registered: 1, not_registered: 1, unknown: 2, pending: 0, invalid: 1, suppressed: 0,
      by_service: { "number.spam": { completed: 2, registered: 1, not_registered: 1, unknown: 2, pending: 0 } } },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: null, metadata: { secret_crm_note: "do-not-echo" }, request_id: "req_s",
  } as unknown as Lookup;
}

describe("spam reputation", () => {
  const numbers = ["+447700900001", "+447700900002", "+447700900003", "+447700900005", "bad"];
  it("check_spam_reputation runs number.spam only and returns a per-number risk summary", async () => {
    const sdk = mockSdk("0.0032", 4);
    sdk.lookup.mockResolvedValueOnce({ data: spamLookup(), error: null });
    const client = await connect(sdk);
    const r = await client.callTool({ name: "check_spam_reputation", arguments: { numbers } });
    expect(r.isError).toBeFalsy();
    expect(sdk.jobs.estimate).toHaveBeenCalledWith(expect.objectContaining({ numbers, checks: ["number.spam"] }));
    expect(sdk.lookup).toHaveBeenCalledWith(numbers, expect.objectContaining({ checks: ["number.spam"], maxCost: "0.0032" }));
    const out = r.structuredContent as { levels: Record<string, number>; results: Record<string, unknown>[] };
    expect(out.levels).toEqual({ high: 1, medium: 0, low: 0, no_reports: 1, not_conclusive: 2, invalid: 1 });
    expect(out.results[0]).toMatchObject({ e164: "+447700900001", status: "completed", risk_level: "high", risk_score: 95,
      reasons: ["regulator", "community"], voip_range: false, top_category: "robocall", first_seen: "2025-11", sources: 2 });
    expect(out.results[1]).toMatchObject({ risk_level: "no_reports", risk_score: 0, reasons: [], top_category: null });
    expect(out.results[2]).toMatchObject({ status: "unknown", risk_level: null, risk_score: null, reason: "UPSTREAM_TIMEOUT" });
    expect(out.results[3]).toMatchObject({ status: "unsupported_country", risk_level: null });
    expect(out.results[4]).toMatchObject({ number_status: "invalid_number", status: null });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/1 high, 0 medium, 0 low, 1 no reports, 2 not conclusive/);
    expect(text).toMatch(/does not mean the number is safe/);
    expect(JSON.stringify(r)).not.toContain("do-not-echo");
  });
  it("check_spam_reputation keeps the spend gate", async () => {
    const sdk = mockSdk("2.50", 5);
    const client = await connect(sdk);
    const r = await client.callTool({ name: "check_spam_reputation", arguments: { numbers: nums(5) } });
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("confirmation_required");
    expect((r.content as { text: string }[])[0]!.text).toMatch(/call check_spam_reputation again/);
    expect(sdk.lookup).not.toHaveBeenCalled();
  });
  it("lookup_numbers passes integer attributes through (output schema accepts numbers)", async () => {
    const sdk = mockSdk();
    sdk.lookup.mockResolvedValueOnce({ data: spamLookup(), error: null });
    const client = await connect(sdk);
    const r = await client.callTool({ name: "lookup_numbers", arguments: { numbers: numbers.slice(0, 2), checks: ["spam"] } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as { results: { checks?: Record<string, { attributes: Record<string, unknown> | null }> }[] };
    expect(out.results[0]!.checks!["number.spam"]!.attributes!.risk_score).toBe(95);
  });
  it("descriptions: spam alias listed, limits and meaning stated, sanctioned countries excluded, hlr/mnp offered", async () => {
    const client = await connect(mockSdk());
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "check_spam_reputation")!;
    expect(t.description).toMatch(/All countries except sanctioned ones/);
    expect(t.description).not.toMatch(/US, CA, DE/);
    expect(t.description).toMatch(/NOT that the number is safe/);
    expect(t.description).toMatch(/Up to 100|up to 100/i);
    expect(t.description).toMatch(/consecutive numbers/);
    expect((t.inputSchema.properties as Record<string, { maxItems?: number }>).numbers!.maxItems).toBe(100);
    expect(t.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const checksDesc = (tools.find((x) => x.name === "lookup_numbers")!.inputSchema.properties as Record<string, { description?: string }>).checks!.description!;
    expect(checksDesc).toMatch(/Aliases: [^;]*\bspam\b/);
    expect(checksDesc).toContain("number.spam");
    expect(checksDesc).toMatch(/number\.hlr/);
    expect(checksDesc).toMatch(/number\.mnp/);
  });
});
