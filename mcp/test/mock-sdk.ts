// Shared mock of the MobileValidate SDK subset the tools use (tools.test.ts, protocol.test.ts).
import type { Estimate, Lookup } from "mobilevalidate";
import { vi } from "vitest";

export const money = (amount: string) => ({ amount, currency: "USD" });

export function lookup(): Lookup {
  return {
    object: "lookup", id: "lkp_1", status: "completed", livemode: false, created_at: "2026-09-25T10:00:00Z",
    results: [
      { input: "+447700900001", e164: "+447700900001", country: "GB", number_status: "valid", test: true,
        whatsapp: { service: "whatsapp.registered", status: "completed", registered: true, confidence: "high", confidence_score: 0.96,
          checked_at: "2026-09-25T10:00:00Z", cached: false, age_seconds: 0, billed: false, reason: null, poll_after_ms: null } },
      { input: "+447700900003", e164: "+447700900003", country: "GB", number_status: "valid", test: true,
        whatsapp: { service: "whatsapp.registered", status: "unknown", registered: null, confidence: null, confidence_score: null,
          checked_at: null, cached: false, age_seconds: null, billed: false, reason: "UPSTREAM_TIMEOUT", poll_after_ms: null } },
    ],
    summary: { total: 2, registered: 1, not_registered: 0, unknown: 1, pending: 0, invalid: 0, suppressed: 0 },
    billing: { billed_units: 0, cost: money("0"), balance_after: money("10.00") },
    next: null, metadata: { secret_crm_note: "do-not-echo" }, request_id: "req_1",
  };
}

const micro = (a: string) => BigInt(a.replace(".", "").padEnd(a.split(".")[0]!.length + 6, "0").slice(0, a.split(".")[0]!.length + 6));
const usdOf = (m: bigint) => (Number(m) / 1e6).toFixed(6).replace(/\.?0+$/, "");

/** `estimateCost` = the real-time cost of `count` numbers (whatsapp.registered's real-time price is set to match). */
export function mockSdk(estimateCost = "0.0024", count = 2) {
  const estimate: Estimate = { total: count, valid: count, invalid: 0, duplicate: 0, cached: 0, unsupported: 0, suppressed: 0, billable_max: count,
    max_cost: money(estimateCost), checks: ["whatsapp.registered"] };
  const waRealtime = usdOf(micro(estimateCost) / BigInt(count));
  const sdk = {
    lookup: vi.fn(async (): Promise<{ data: Lookup | null; error: unknown }> => ({ data: lookup(), error: null })),
    services: vi.fn(async () => ({ data: { object: "list", has_more: false, data: [
      { object: "service", code: "whatsapp.registered", name: "WhatsApp registration", platform: "WhatsApp", family: "messaging", input_type: "phone",
        result_kind: "boolean", attributes: [], realtime: true, batch: true, status: "active", beta: false, countries: [],
        prices: { realtime: money(waRealtime), batch: money("0.0003") } },
      { object: "service", code: "email.valid", name: "E-mail mailbox", platform: "E-mail", family: "email", input_type: "email",
        result_kind: "boolean", attributes: [], realtime: true, batch: true, status: "active", beta: false, countries: [],
        prices: { realtime: money("0.002"), batch: money("0.001") } },
      { object: "service", code: "telegram.registered", name: "Telegram registration", platform: "Telegram", family: "messaging", input_type: "phone",
        result_kind: "boolean", attributes: [], realtime: true, batch: true, status: "active", beta: false, countries: [],
        prices: { realtime: money("0.0005"), batch: money("0.0003") } },
      { object: "service", code: "signal.registered", name: "Signal registration", platform: "Signal", family: "messaging", input_type: "phone",
        result_kind: "boolean", attributes: [], realtime: false, batch: true, status: "active", beta: false, countries: [],
        prices: { realtime: null, batch: money("0.0003") } },
    ] }, error: null })),
    jobs: {
      estimate: vi.fn(async () => ({ data: estimate, error: null })),
      create: vi.fn(async () => ({ data: { object: "job", id: "job_1", status: "queued", created_at: "x" }, error: null })),
      get: vi.fn(async () => ({ data: { object: "job", id: "job_1", status: "running", created_at: "x", progress: { total: 3, done: 1, conclusive: 1, non_billable: 0 } }, error: null })),
      resultsPage: vi.fn(async () => ({ data: { data: lookup().results, has_more: true, next_cursor: "c2" }, error: null })),
    },
    account: { get: vi.fn(async () => ({ data: { org_id: "org_1", balance: money("10.00"), reserved: money("0") }, error: null })) },
    limits: { get: vi.fn(async () => ({ data: { requests_per_second: 10 }, error: null })) },
  };
  return sdk;
}
