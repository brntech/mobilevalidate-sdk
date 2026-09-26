import { MobileValidate, type FetchLike, type MobileValidateOptions } from "../src/index.ts";

export interface Call { url: URL; method: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | Error;

/** fetch mock that replays queued replies and records requests. */
export function mockFetch(replies: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url: new URL(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = replies.shift();
    if (!r) throw new Error("no more mock replies");
    if (r instanceof Error) throw r;
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status, headers: r.headers ?? {} });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

export function client(replies: Reply[], opts: MobileValidateOptions = {}) {
  const m = mockFetch(replies);
  const sleeps: number[] = [];
  const mv = new MobileValidate({
    apiKey: "mv_test_abcdefghijklmnopqrstuvwxyz0123abcdef",
    baseUrl: "http://api.test",
    fetch: m.fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    ...opts,
  });
  return { mv, calls: m.calls, sleeps };
}

export const money = (amount: string) => ({ amount, currency: "USD" });

export function lookup(status: "completed" | "pending", registered: boolean | null = true) {
  return {
    object: "lookup", id: "lkp_1", status, livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [{
      input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid", test: true,
      whatsapp: {
        service: "whatsapp.registered", status: status === "pending" ? "pending" : "completed",
        registered: status === "pending" ? null : registered, confidence: "high", confidence_score: 0.96,
        checked_at: "2026-09-25T10:00:00Z", cached: false, age_seconds: 0, billed: false, reason: null,
        poll_after_ms: status === "pending" ? 2000 : null, future_field: "tolerated",
      },
    }],
    summary: { total: 1, registered: registered && status === "completed" ? 1 : 0, not_registered: 0, unknown: 0, pending: status === "pending" ? 1 : 0, invalid: 0, suppressed: 0 },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: status === "pending" ? { poll_url: "/v1/lookups/lkp_1", poll_after_ms: 2000 } : null,
    request_id: "req_1",
  };
}

export const errorBody = (code: string, status: number, retryable: boolean) => ({
  error: { code, message: `${code} happened`, status, retryable, param: null, request_id: "req_err" },
});

const check = (service: string, registered: boolean | null, attributes: Record<string, string | boolean | number> | null = null) => ({
  service, status: registered === null && !attributes ? "unknown" : "completed", registered, attributes,
  confidence: "high", confidence_score: 0.95, checked_at: "2026-09-25T10:00:00Z", cached: false, age_seconds: 0,
  billed: false, reason: null, poll_after_ms: null,
});

/** Multi-check lookup: telegram + viber + carrier. */
export function multiLookup() {
  return {
    object: "lookup", id: "lkp_2", status: "completed", livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [{
      input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid", test: true,
      checks: {
        "telegram.registered": check("telegram.registered", true),
        "viber.registered": check("viber.registered", false),
        "network.carrier": check("network.carrier", null, { line_type: "mobile", carrier: "Test Carrier", country: "GB" }),
      },
    }],
    summary: { total: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0, invalid: 0, suppressed: 0,
      by_service: {
        "telegram.registered": { completed: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0 },
        "viber.registered": { completed: 1, registered: 0, not_registered: 1, unknown: 0, pending: 0 },
        "network.carrier": { completed: 1, registered: 1, not_registered: 0, unknown: 0, pending: 0 },
      } },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: null, request_id: "req_2",
  };
}

/** number.spam lookup (current servers: registered true for data): high, no_reports, unknown, unsupported. */
export function spamLookup() {
  const row = (n: string, c: Record<string, unknown>) => ({ input: n, e164: n, country: "GB", number_status: "valid", test: true,
    checks: { "number.spam": c } });
  const na = (status: string, reason: string) => ({ ...check("number.spam", null), status, reason, confidence: null, confidence_score: null, checked_at: null });
  return {
    object: "lookup", id: "lkp_s", status: "completed", livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [
      row("+447700900001", check("number.spam", true, { risk_level: "high", risk_score: 95, reason_regulator: true, reason_community: true, top_category: "robocall", sources: 2 })),
      row("+447700900002", check("number.spam", true, { risk_level: "no_reports", risk_score: 0, sources: 0 })),
      row("+447700900003", na("unknown", "UPSTREAM_TIMEOUT")),
      row("+447700900005", na("unsupported_country", "UNSUPPORTED_COUNTRY")),
    ],
    summary: { total: 4, registered: 1, not_registered: 1, unknown: 2, pending: 0, invalid: 0, suppressed: 0,
      by_service: { "number.spam": { completed: 2, registered: 1, not_registered: 1, unknown: 2, pending: 0 } } },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: null, request_id: "req_s",
  };
}

export function servicesList() {
  const svc = (code: string, platform: string, realtime: boolean, attributes: string[] = []) => ({
    object: "service", code, name: `${platform} registration`, platform, family: "messaging", input_type: "phone",
    result_kind: attributes.length && code.startsWith("network.") ? "attributes" : "boolean",
    attributes: attributes.map((key) => ({ key, type: "string", description: key })), realtime, batch: true,
    status: "active", beta: false, countries: [], prices: { realtime: realtime ? money("0.0005") : null, batch: money("0.0003") },
  });
  return { object: "list", has_more: false, data: [svc("telegram.registered", "Telegram", true), svc("signal.registered", "Signal", false),
    svc("network.carrier", "Mobile network", true, ["line_type", "carrier"])] };
}

/** E-mail lookup: two test-domain rows checked with email.valid. */
export function emailLookup() {
  return {
    object: "lookup", id: "lkp_3", status: "completed", livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [
      { kind: "email", input: "registered@test.mobilevalidate.com", email: "registered@test.mobilevalidate.com", email_status: "valid",
        e164: null, country: null, test: true, checks: { "email.valid": check("email.valid", true) } },
      { kind: "email", input: "not-registered@test.mobilevalidate.com", email: "not-registered@test.mobilevalidate.com",
        email_status: "valid", e164: null, country: null, test: true, checks: { "email.valid": check("email.valid", false) } },
    ],
    summary: { total: 2, registered: 1, not_registered: 1, unknown: 0, pending: 0, invalid: 0, suppressed: 0,
      by_service: { "email.valid": { completed: 2, registered: 1, not_registered: 1, unknown: 0, pending: 0 } } },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: null, request_id: "req_3",
  };
}
