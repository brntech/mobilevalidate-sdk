import { createHash } from "node:crypto";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, type CallToolResult } from "@modelcontextprotocol/server";
import { SERVICE_ALIASES, SERVICE_CATALOG, type CheckResult, type Estimate, type Job, type Lookup, type MobileValidate,
  type MobileValidateError, type Money, type ResultItem, type Service } from "mobilevalidate";
import { z } from "zod";
import { normalizeNumbers } from "./normalize.ts";
import { fromMicro, log, toMicro } from "./util.ts";

export const SERVER_NAME = "mobilevalidate";
export const SERVER_VERSION = "1.2.0";

/**
 * MCP protocol revisions served, newest first (both transports). `2026-07-28` is the stateless "modern" revision
 * (per-request `_meta`, `server/discover`); the rest are the "legacy" `initialize`-handshake revisions the SDK still
 * negotiates. The SDK exports no public constant for modern revisions, so it is named here; test/protocol.test.ts
 * checks it against what the server actually advertises (`server/discover` and the `initialize` handshake).
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const PROTOCOL_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];

/**
 * 2026-07-28 cache hints (SEP-2549). The tool list and discovery result are identical for every key (no prices, no
 * per-key filtering, no confirmation threshold in them), so shared caches may keep them for an hour.
 */
const PUBLIC_1H = { ttlMs: 3_600_000, cacheScope: "public" as const };

/** The subset of the SDK the tools use (lets tests inject a mock). */
export type Sdk = Pick<MobileValidate, "lookup" | "services" | "jobs" | "account" | "limits">;

export interface ToolOptions {
  /** Spend above this (USD decimal string) needs explicit confirmation. Default "1.00" (env MCP_CONFIRM_ABOVE_USD). */
  confirmAboveUsd?: string;
}

const LOOKUP_MAX = 100;
const JOB_MAX = 50_000;

const PHONE_SERVICES = SERVICE_CATALOG.filter((s) => s.inputType === "phone");
const EMAIL_SERVICES = SERVICE_CATALOG.filter((s) => s.inputType === "email");
const REALTIME_CODES = PHONE_SERVICES.filter((s) => s.realtime).map((s) => s.code);
const BULK_ONLY_CODES = PHONE_SERVICES.filter((s) => !s.realtime).map((s) => s.code);
const EMAIL_REALTIME_CODES = EMAIL_SERVICES.filter((s) => s.realtime).map((s) => s.code);
const EMAIL_BULK_ONLY_CODES = EMAIL_SERVICES.filter((s) => !s.realtime).map((s) => s.code);
const EMAIL_CODES = new Set<string>(EMAIL_SERVICES.map((s) => s.code));
const aliasList = Object.keys(SERVICE_ALIASES).filter((a) => !EMAIL_CODES.has((SERVICE_ALIASES as Record<string, string>)[a]!)).join(", ");
const emailAliasList = Object.keys(SERVICE_ALIASES).filter((a) => EMAIL_CODES.has((SERVICE_ALIASES as Record<string, string>)[a]!)).join(", ");

/** Anti-enumeration and volume limits every spending tool states. */
const LIMITS_NOTE = "Limits: ≥ 20 numerically consecutive numbers (or ≥ 20 e-mail addresses on one domain differing only " +
  "by digits/separators) in one request are refused as enumeration " +
  "(suspected_enumeration); daily number caps and per-key spend caps apply. Never use this to discover who uses a platform " +
  "(\"find all users of X\") — only check numbers the user legitimately holds.";

/** E-mail rules: anti-enumeration + privacy. */
const EMAIL_NOTE = "E-mail checks answer only whether a mailbox/account exists (registered true/false/null) — never names, " +
  "photos, profiles or any other personal data. ≥ 20 addresses on one domain that differ only by digits (john1@…, john2@…) " +
  "are refused as enumeration (suspected_enumeration); e-mails count toward the daily cap like numbers. Only check addresses " +
  "the user legitimately holds (e.g. their own sign-ups or customers), for fraud prevention or deliverability.";

/** Spam reputation: what the answer means and what it does not. */
const SPAM_NOTE = "Spam reputation (number.spam, alias spam) is report-based: risk_level high/medium/low/no_reports, " +
  "risk_score 0–100, reasons (regulator action, government complaint data, community reports, recently offered as an " +
  "unassigned number). All countries except sanctioned ones (Cuba, Iran, North Korea, Syria, Russia, Belarus, Venezuela: unsupported_country, free). no_reports means no reports are " +
  "known — NOT that the number is safe. Every risk_level including no_reports is billed; unknown/unsupported are free. " +
  "No report texts or names are returned.";

const INSTRUCTIONS = `MobileValidate checks phone numbers: registration on messaging/social/app platforms (WhatsApp, Telegram,
Viber, Signal, …), carrier/line type and spam reputation (check_spam_reputation) — and e-mail addresses (mailbox exists;
account on Gmail, Outlook, Apple, …).
Pass several services in \`checks\`; each number / address gets one result per service of its kind (phone services for
numbers, e-mail services for emails). Use lookup_emails for addresses only, or pass numbers and emails together.
Results are registered true / false / null (null = unknown, never billed); data services (carrier, spam) return attributes.
Some services are bulk only (create_lookup_job); list_services shows what the key can use and the prices.
Typical flow: list_services → normalize_numbers (free) → estimate_cost (free) → lookup_numbers (≤100, spends credits) or
create_lookup_job (bulk) → get_lookup_job. Only check numbers your user has a legitimate relationship with.
${LIMITS_NOTE}
${EMAIL_NOTE}
${SPAM_NOTE}
Spending above the confirmation threshold requires the USER to approve the exact amount first.`;

// ---------- schemas ----------
const decimal = z.string().regex(/^\d+(\.\d+)?$/, "decimal string like \"1.50\"");
const numbersShape = (max: number) =>
  z.array(z.string().min(1).max(32)).min(1).max(max)
    .describe(`Phone numbers, ideally E.164 like "+447700900001". National formats need default_country. At most ${max}.`);
const emailsShape = (max: number) =>
  z.array(z.string().min(1).max(254)).min(1).max(max).optional()
    .describe(`E-mail addresses (checked by e-mail services only). Numbers + emails: at most ${max} in total. ${EMAIL_NOTE}`);
const checksDescription = (bulk: boolean) =>
  `Services to check (codes or aliases); each number / e-mail gets one result per service of its kind. Default ["whatsapp"]. ` +
  `Phone services (for numbers) — real time: ${REALTIME_CODES.join(", ")}. ` +
  (bulk ? `Also bulk only: ${BULK_ONLY_CODES.join(", ")}. ` : `Bulk only (use create_lookup_job): ${BULK_ONLY_CODES.join(", ")}. `) +
  `E-mail services (for emails) — real time: ${EMAIL_REALTIME_CODES.join(", ")}; ` +
  (bulk ? `bulk only: ${EMAIL_BULK_ONLY_CODES.join(", ")}. ` : `bulk only (use create_lookup_job): ${EMAIL_BULK_ONLY_CODES.join(", ")}. `) +
  `If emails are sent, include at least one e-mail service (and a phone service for numbers). ` +
  `At most 20 checks; numbers/e-mails × applicable checks ≤ ${bulk ? "100,000 per job" : "2,000 per request"}. ` +
  `Aliases: ${aliasList}; e-mail: ${emailAliasList}. Call list_services for what this key can use.`;
const checksShape = (bulk: boolean) => z.array(z.string().min(1).max(64)).min(1).max(20).optional().describe(checksDescription(bulk));
const checks = checksShape(false);
const checksBulk = checksShape(true);
const defaultCountry = z.string().regex(/^[A-Za-z]{2}$/).optional()
  .describe('ISO 3166-1 alpha-2 country for national-format numbers, e.g. "GB".');
const maxAge = z.number().int().min(0).optional()
  .describe("Accept cached answers up to this age in seconds (cache hits are free). 0 forces a fresh, billed check.");
const confirmMaxCost = decimal.optional()
  .describe("Only after the USER explicitly approved the cost shown by a confirmation_required result: that exact USD amount.");
const responseFormat = z.enum(["concise", "detailed"]).optional()
  .describe('"concise" (default) or "detailed" (adds input, confidence_score, age_seconds).');

const MoneyOut = z.object({ amount: z.string(), currency: z.string() });
const CheckOut = z.object({
  status: z.string(),
  registered: z.boolean().nullable(),
  /** Values: strings, booleans or integers (e.g. number.spam risk_score). */
  attributes: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).nullable(),
  confidence: z.string().nullable(),
  checked_at: z.string().nullable(),
  cached: z.boolean(),
  billed: z.boolean(),
  reason: z.string().nullable(),
});
const ItemOut = z.object({
  /** "phone" or "email". */
  kind: z.string(),
  e164: z.string().nullable(),
  country: z.string().nullable(),
  /** Phone rows: number status; null on e-mail rows. */
  number_status: z.string().nullable(),
  /** E-mail rows only: normalized address and its status. */
  email: z.string().nullable().optional(),
  email_status: z.string().optional(),
  registered: z.boolean().nullable(),
  business: z.boolean().nullable().optional(),
  check_status: z.string().nullable(),
  confidence: z.string().nullable(),
  checked_at: z.string().nullable(),
  cached: z.boolean().nullable(),
  billed: z.boolean().nullable(),
  reason: z.string().nullable(),
  test: z.boolean().optional(),
  input: z.string().optional(),
  confidence_score: z.number().nullable().optional(),
  age_seconds: z.number().nullable().optional(),
  /** Per service (keyed by service code) when the item has results. */
  checks: z.record(z.string(), CheckOut).optional(),
});
const EstimateOut = z.object({
  total: z.number(), valid: z.number(), invalid: z.number(), duplicate: z.number(), cached: z.number(),
  unsupported: z.number(), suppressed: z.number(), billable_max: z.number(), max_cost: MoneyOut,
  checks_total: z.number().optional(),
  /** Checks priced at the real-time price because their part is too small for the batch route. */
  small_batch: z.array(z.object({ check: z.string(), checks: z.number(), unit_price: MoneyOut, countries: z.array(z.string()),
    batch_minimum: z.number().optional() })).optional(),
});
const ServiceOut = z.object({
  code: z.string(), name: z.string(), platform: z.string(), input_type: z.string(), result_kind: z.string(), realtime: z.boolean(),
  status: z.string(), beta: z.boolean(), attributes: z.array(z.string()), countries: z.array(z.string()),
  price_realtime: MoneyOut.nullable(), price_batch: MoneyOut.nullable(),
});

// ---------- helpers ----------
type Structured = Record<string, unknown>;

function ok(structured: Structured, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(code: string, message: string, extra: Structured = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: { error: { code, message, ...extra } } };
}

const HINTS: Record<string, string> = {
  unauthorized: "The API key was rejected. Check that it is a valid, active mv_agent_ or mv_test_ key.",
  insufficient_balance: "Not enough credit. Ask the user to top up, or reduce the list.",
  cost_limit_exceeded: "The price changed since the estimate. Call estimate_cost again and ask the user to confirm the new amount.",
  spend_cap_reached: "The key's spend cap is reached. The user must raise it in the dashboard; do not retry.",
  daily_cap_reached: "Today's cap is reached; it resets at 00:00 UTC.",
  rate_limited: "Rate limited. Wait a few seconds and retry once.",
  test_number_only: "Test numbers (+447700900xxx) and test e-mail addresses (@test.mobilevalidate.com) only work with test keys.",
  suspected_enumeration: "The request looks like enumeration (a sequential number range, or generated e-mail addresses differing only by digits) and was refused. Only check numbers and addresses the user legitimately holds.",
  invalid_request: "The request was invalid; check the parameter named in `param` (e-mails need an e-mail check such as \"email\"; numbers need a phone check).",
  too_many_numbers: `lookup_numbers / lookup_emails take at most ${LOOKUP_MAX} numbers and e-mails together; use create_lookup_job for more.`,
  service_disabled: "If the message says 'bulk jobs only', use create_lookup_job for that service; otherwise the service is not available to this key (see list_services).",
};

function apiFail(err: MobileValidateError): CallToolResult {
  const hint = HINTS[err.code] ? ` ${HINTS[err.code]}` : "";
  return fail(String(err.code), `${err.message}.${hint}`.replace("..", "."), {
    status: err.status, retryable: err.retryable, param: err.param, request_id: err.requestId,
  });
}

const usd = (m: Money | undefined | null) => (m ? `$${m.amount}` : "$0");

function shapeCheck(c: CheckResult) {
  return {
    status: String(c.status), registered: c.registered ?? null, attributes: c.attributes ?? null, confidence: c.confidence ?? null,
    checked_at: c.checked_at ?? null, cached: !!c.cached, billed: !!c.billed, reason: c.reason ?? null,
  };
}

/** Top-level fields describe WhatsApp when requested (v1 shape), else the first requested service; `checks` has all. */
function shapeItem(r: ResultItem, detailed: boolean) {
  const all = Object.entries(r.checks ?? {}).filter((e): e is [string, CheckResult] => !!e[1]);
  const w = r.whatsapp ?? all[0]?.[1];
  const email = r.kind === "email";
  const base = {
    kind: email ? "email" : "phone",
    e164: r.e164 ?? null,
    country: r.country ?? null,
    number_status: email ? null : String(r.number_status ?? "valid"),
    ...(email ? { email: r.email ?? null, email_status: String(r.email_status ?? "valid") } : {}),
    registered: w ? w.registered : null,
    ...(r.whatsapp && r.whatsapp.business !== undefined ? { business: r.whatsapp.business ?? null } : {}),
    check_status: w ? String(w.status) : null,
    confidence: w?.confidence ?? null,
    checked_at: w?.checked_at ?? null,
    cached: w ? w.cached : null,
    billed: w ? w.billed : null,
    reason: w?.reason ?? null,
    ...(r.test !== undefined ? { test: r.test } : {}),
    ...(all.length > 1 || (all.length === 1 && !r.whatsapp) ? { checks: Object.fromEntries(all.map(([k, c]) => [k, shapeCheck(c)])) } : {}),
  };
  return detailed ? { ...base, input: r.input, confidence_score: w?.confidence_score ?? null, age_seconds: w?.age_seconds ?? null } : base;
}

function shapeService(s: Service) {
  return {
    code: String(s.code), name: s.name, platform: s.platform, input_type: String(s.input_type ?? "phone"),
    result_kind: String(s.result_kind), realtime: !!s.realtime,
    status: String(s.status), beta: !!s.beta, attributes: (s.attributes ?? []).map((a) => a.key), countries: s.countries ?? [],
    price_realtime: s.prices?.realtime ?? null, price_batch: s.prices?.batch ?? null,
  };
}

function shapeEstimate(e: Estimate) {
  return {
    total: e.total ?? 0, valid: e.valid ?? 0, invalid: e.invalid ?? 0, duplicate: e.duplicate ?? 0, cached: e.cached ?? 0,
    unsupported: e.unsupported ?? 0, suppressed: e.suppressed ?? 0, billable_max: e.billable_max ?? 0,
    max_cost: { amount: e.max_cost?.amount ?? "0", currency: e.max_cost?.currency ?? "USD" },
    ...(e.checks_total !== undefined ? { checks_total: e.checks_total } : {}),
    ...smallBatchOf(e),
  };
}

/** Price lines billed at the real-time price because the part is too small for the batch route. */
function smallBatchOf(e: Estimate) {
  const lines = (e.breakdown ?? []).filter((l) => l.reason === "small_batch");
  if (!lines.length) return {};
  return { small_batch: lines.map((l) => ({ check: String(l.check), checks: l.checks,
    unit_price: { amount: l.unit_price.amount, currency: l.unit_price.currency }, countries: l.countries ?? [],
    ...(l.batch_minimum !== undefined ? { batch_minimum: l.batch_minimum } : {}) })) };
}

/** Decide whether spending needs explicit user confirmation, and which cap to send to the API. */
function spendGate(cost: string, count: number, thresholdMicro: bigint, confirm: string | undefined, bulk: boolean) {
  const costMicro = toMicro(cost);
  const needs = costMicro > thresholdMicro || (bulk && count > LOOKUP_MAX);
  if (needs && (confirm === undefined || toMicro(confirm) < costMicro)) return { confirmed: false as const, costMicro };
  // The confirmed (or estimated) amount is sent as max_cost so the API itself refuses anything more expensive.
  return { confirmed: true as const, maxCost: confirm ?? fromMicro(costMicro) };
}

function confirmationRequired(cost: string, count: number, thresholdUsd: string, tool: string): CallToolResult {
  const why = toMicro(cost) > toMicro(thresholdUsd)
    ? `the maximum cost $${cost} is above the $${thresholdUsd} confirmation threshold`
    : `the list has ${count} numbers/e-mails (more than ${LOOKUP_MAX})`;
  const message = `Confirmation required: ${why}. This will check ${count} numbers/e-mails for at most $${cost} ` +
    `(non-conclusive results are not billed). Show this amount to the USER and ask them to approve it explicitly. ` +
    `Only if they approve, call ${tool} again with the same arguments plus confirm_max_cost: "${cost}". Do not confirm on the user's behalf.`;
  return fail("confirmation_required", message, { max_cost: { amount: cost, currency: "USD" }, numbers: count, confirm_above: thresholdUsd });
}

function argsHash(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 48);
}

// ---------- server ----------
export function buildServer(sdk: Sdk, opts: ToolOptions = {}): McpServer {
  const thresholdUsd = opts.confirmAboveUsd ?? process.env.MCP_CONFIRM_ABOVE_USD ?? "1.00";
  const thresholdMicro = toMicro(thresholdUsd);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "MobileValidate", websiteUrl: "https://mobilevalidate.com/docs/mcp" },
    { instructions: INSTRUCTIONS, cacheHints: { "tools/list": PUBLIC_1H, "server/discover": PUBLIC_1H } },
  );

  server.registerTool("normalize_numbers", {
    title: "Normalize phone numbers (free)",
    description: "Validate and format phone numbers to E.164 for free, without checking any platform. Use before lookup_numbers when inputs are messy. Format-level only: it flags ambiguous inputs (no country) instead of guessing; the check itself does full validation.",
    inputSchema: z.object({ numbers: numbersShape(1000), default_country: defaultCountry }),
    outputSchema: z.object({
      results: z.array(z.object({ input: z.string(), e164: z.string().nullable(), country: z.string().nullable(), status: z.string(), note: z.string().nullable() })),
      summary: z.object({ total: z.number(), valid: z.number(), invalid: z.number(), ambiguous: z.number(), duplicate: z.number() }),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ numbers, default_country }) => {
    const out = normalizeNumbers(numbers, default_country?.toUpperCase());
    const s = out.summary;
    return ok(out, `${s.total} numbers: ${s.valid} valid, ${s.ambiguous} ambiguous, ${s.invalid} invalid, ${s.duplicate} duplicate.`);
  });

  /** Identifiers of a request: at least one number or e-mail; ≤ max together. */
  const idsOf = (a: { numbers?: string[]; emails?: string[] }, max: number) => {
    const numbers = a.numbers?.length ? a.numbers : undefined;
    const emails = a.emails?.length ? a.emails : undefined;
    const count = (numbers?.length ?? 0) + (emails?.length ?? 0);
    if (!count) return { error: fail("invalid_request", "Provide at least one phone number (numbers) or e-mail address (emails).", { param: "numbers" }) };
    if (count > max) {
      return { error: fail("too_many_numbers", `At most ${max} numbers and e-mails together.${max === LOOKUP_MAX ? " Use create_lookup_job for more." : ""}`, { param: "emails" }) };
    }
    return { numbers, emails, count };
  };

  server.registerTool("estimate_cost", {
    title: "Estimate cost (free)",
    description: "Estimate the price of checking numbers and/or e-mail addresses for the given services, for free, without spending credits. Returns counts (valid, invalid, duplicate, cached; cached and billable_max count identifier × service checks) and the maximum possible cost of a bulk job (create_lookup_job) at bulk prices; checks in parts too small for the bulk route (fewer numbers of one country than the bulk minimum) are priced at real-time prices and listed in small_batch. Real-time tools price at real-time rates and quote that amount in their own confirmation.",
    inputSchema: z.object({ numbers: numbersShape(JOB_MAX).optional(), emails: emailsShape(JOB_MAX), checks: checksBulk, default_country: defaultCountry, max_age: maxAge }),
    outputSchema: z.object({ ...EstimateOut.shape, requires_confirmation: z.boolean(), confirm_above: MoneyOut }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    const ids = idsOf(a, JOB_MAX);
    if (ids.error) return ids.error;
    const { data, error } = await sdk.jobs.estimate({ numbers: ids.numbers, emails: ids.emails, checks: a.checks,
      defaultCountry: a.default_country?.toUpperCase(), maxAge: a.max_age });
    if (error) return apiFail(error);
    const e = shapeEstimate(data);
    const requires = toMicro(e.max_cost.amount) > thresholdMicro || ids.count > LOOKUP_MAX;
    log("estimate_cost", { n: ids.count, max_cost: e.max_cost.amount });
    return ok({ ...e, requires_confirmation: requires, confirm_above: { amount: thresholdUsd, currency: "USD" } },
      `${e.valid} valid of ${e.total} (${e.cached} cached, ${e.invalid} invalid, ${e.duplicate} duplicate). Maximum cost ${usd(e.max_cost)}.` +
      (e.small_batch ? ` ${e.small_batch.map((l) => `${l.checks} ${l.check} checks (${l.countries.join(", ")}) are priced at the real-time price because fewer than ${l.batch_minimum ?? "the minimum"} numbers per country were sent`).join("; ")}.` : "") +
      (requires ? " Spending this requires explicit user confirmation." : ""));
  });

  const lookupOutput = z.object({
    lookup_id: z.string(), status: z.string(),
    summary: z.object({ total: z.number(), registered: z.number(), not_registered: z.number(), unknown: z.number(), pending: z.number(), invalid: z.number(), suppressed: z.number(),
      by_service: z.record(z.string(), z.object({ completed: z.number(), registered: z.number(), not_registered: z.number(), unknown: z.number(), pending: z.number() }).partial()) }).partial(),
    results: z.array(ItemOut), cost: MoneyOut.nullable(), balance_after: MoneyOut.nullable(), pending_lookup_id: z.string().nullable(),
  });
  const waitSeconds = z.number().int().min(0).max(30).optional().describe("Seconds to wait for slow answers (default 20). Pending items return pending_lookup_id.");

  type LookupArgs = { numbers?: string[]; emails?: string[]; checks?: string[]; default_country?: string;
    max_age?: number; wait_seconds?: number; response_format?: "concise" | "detailed"; confirm_max_cost?: string };

  /**
   * Worst-case cost of a REAL-TIME lookup at real-time prices. The free estimate (POST /v1/jobs/estimate) validates the
   * input and counts valid identifiers but prices at bulk rates, so the amount is rebuilt from the key's real-time prices
   * (GET /v1/services, with the org's overrides): valid identifiers of each kind × Σ real-time prices of that kind's
   * checks. Cache hits are free, so the lookup's own reserve is never higher and max_cost never refuses a confirmed call.
   */
  const realtimeMaxCost = async (ids: { numbers?: string[]; emails?: string[] },
    params: { checks?: string[]; defaultCountry?: string; maxAge?: number }): Promise<{ cost: string } | { result: CallToolResult }> => {
    const est = await sdk.jobs.estimate({ numbers: ids.numbers, emails: ids.emails, ...params });
    if (est.error) return { result: apiFail(est.error) };
    if (!est.data.billable_max) return { cost: "0" }; // test keys, or nothing valid to check
    const svc = await sdk.services();
    if (svc.error) return { result: apiFail(svc.error) };
    const byCode = new Map((svc.data.data ?? []).map((s) => [String(s.code), s]));
    const unit = { phone: 0n, email: 0n };
    const codes = { phone: [] as string[], email: [] as string[] };
    for (const code of est.data.checks ?? []) {
      const s = byCode.get(String(code));
      const kind = s?.input_type === "email" ? "email" : "phone";
      codes[kind].push(String(code));
      // A service without a real-time price is bulk only: the API refuses the lookup (service_disabled) before any spend.
      if (s?.prices?.realtime) unit[kind] += toMicro(s.prices.realtime.amount);
    }
    const valid = est.data.valid ?? 0;
    let phones = ids.numbers ? valid : 0;
    if (ids.numbers && ids.emails) {
      // Mixed request: count the valid numbers alone (with the phone checks) to split the valid total by kind.
      const only = await sdk.jobs.estimate({ numbers: ids.numbers, emails: undefined, ...params, checks: codes.phone });
      if (only.error) return { result: apiFail(only.error) };
      phones = only.data.valid ?? 0;
    }
    const emails = ids.emails ? valid - phones : 0;
    return { cost: fromMicro(BigInt(phones) * unit.phone + BigInt(emails) * unit.email) };
  };

  /** Free estimate → spend gate at real-time prices → real-time lookup. Returns the lookup, or a ready tool result. */
  const gatedLookup = async (tool: string, a: LookupArgs): Promise<{ result: CallToolResult } | { data: Lookup; count: number; noun: string }> => {
    const ids = idsOf(a, LOOKUP_MAX);
    if (ids.error) return { result: ids.error };
    const params = { checks: a.checks, defaultCountry: a.default_country?.toUpperCase(), maxAge: a.max_age };
    const priced = await realtimeMaxCost(ids, params);
    if ("result" in priced) return priced;
    const cost = priced.cost;
    const gate = spendGate(cost, ids.count, thresholdMicro, a.confirm_max_cost, false);
    if (!gate.confirmed) {
      log(`${tool} confirmation_required`, { n: ids.count, max_cost: cost });
      return { result: confirmationRequired(cost, ids.count, thresholdUsd, tool) };
    }
    const wait = a.wait_seconds ?? 20;
    const opts = { ...params, maxCost: gate.maxCost, wait, waitTimeoutMs: wait * 1000 };
    const { data, error } = ids.emails
      ? await sdk.lookup({ numbers: ids.numbers, emails: ids.emails, ...opts })
      : await sdk.lookup(ids.numbers!, opts);
    if (error) return { result: apiFail(error) };
    log(tool, { n: ids.count, status: data.status, cost: data.billing?.cost?.amount ?? "0" });
    const noun = ids.numbers && ids.emails ? "numbers/e-mails" : ids.emails ? "e-mails" : "numbers";
    return { data, count: ids.count, noun };
  };

  /** Shared by lookup_numbers and lookup_emails. */
  const runLookupTool = async (tool: string, a: LookupArgs): Promise<CallToolResult> => {
    const r = await gatedLookup(tool, a);
    if ("result" in r) return r.result;
    const { data, noun } = r;
    const out = shapeLookup(data, a.response_format === "detailed");
    const s = data.summary;
    const by = Object.entries(s.by_service ?? {});
    const counts = by.length > 1
      ? `${s.total} ${noun} (${s.invalid} invalid): ` + by.map(([k, c]) => `${k} ${c?.registered ?? 0} registered / ${c?.not_registered ?? 0} not / ${c?.unknown ?? 0} unknown / ${c?.pending ?? 0} pending`).join("; ") + ". "
      : `${s.total} checked: ${s.registered} registered, ${s.not_registered} not registered, ${s.unknown} unknown, ${s.pending} pending, ${s.invalid} invalid. `;
    return ok(out,
      counts +
      `Cost ${usd(data.billing?.cost)}${data.billing ? ` (balance ${usd(data.billing.balance_after)})` : ""}.` +
      (data.status === "pending" ? ` Some answers are still pending: lookup ${data.id}.` : ""));
  };

  server.registerTool("lookup_numbers", {
    title: "Check phone numbers (and e-mails) in real time (spends credits)",
    description: `Check up to ${LOOKUP_MAX} phone numbers — optionally together with e-mail addresses (emails) — against one or more services (default WhatsApp; e.g. telegram, viber, carrier, spam; for e-mails e.g. email). For spam reputation alone prefer check_spam_reputation. Returns registered true/false/null per service (null = unknown, never billed), confidence and checked_at; data services return attributes. Bulk-only services (${[...BULK_ONLY_CODES, ...EMAIL_BULK_ONLY_CODES].join(", ")}) are refused here — use create_lookup_job. Spends credits; above the confirmation threshold it returns confirmation_required and the USER must approve the amount. ${LIMITS_NOTE} ${EMAIL_NOTE}`,
    inputSchema: z.object({
      numbers: numbersShape(LOOKUP_MAX).optional(), emails: emailsShape(LOOKUP_MAX), checks, default_country: defaultCountry, max_age: maxAge,
      wait_seconds: waitSeconds, response_format: responseFormat, confirm_max_cost: confirmMaxCost,
    }),
    outputSchema: lookupOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (a) => runLookupTool("lookup_numbers", a));

  server.registerTool("lookup_emails", {
    title: "Check e-mail addresses in real time (spends credits)",
    description: `Check up to ${LOOKUP_MAX} e-mail addresses: does the mailbox exist (check "email"), or does the address have an account on a platform (e.g. ${EMAIL_REALTIME_CODES.filter((c) => c !== "email.valid").slice(0, 4).join(", ")}). Default check ["email"]. Returns registered true/false/null per service (null = unknown, e.g. unsupported mail provider — never billed). Bulk-only e-mail services (${EMAIL_BULK_ONLY_CODES.join(", ")}) are refused here — use create_lookup_job with emails. Spends credits; above the confirmation threshold the USER must approve the amount. ${EMAIL_NOTE}`,
    inputSchema: z.object({
      emails: z.array(z.string().min(1).max(254)).min(1).max(LOOKUP_MAX).describe(`E-mail addresses to check (at most ${LOOKUP_MAX}). Test keys: use @test.mobilevalidate.com (registered@, not-registered@, unknown@ …).`),
      checks: z.array(z.string().min(1).max(64)).min(1).max(20).optional()
        .describe(`E-mail services (codes or aliases). Default ["email"]. Real time: ${EMAIL_REALTIME_CODES.join(", ")}. Bulk only (use create_lookup_job): ${EMAIL_BULK_ONLY_CODES.join(", ")}. Aliases: ${emailAliasList}.`),
      max_age: maxAge, wait_seconds: waitSeconds, response_format: responseFormat, confirm_max_cost: confirmMaxCost,
    }),
    outputSchema: lookupOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (a) => runLookupTool("lookup_emails", { ...a, checks: a.checks ?? ["email"] }));

  const SpamOut = z.object({
    input: z.string(), e164: z.string().nullable(), country: z.string().nullable(), number_status: z.string(),
    /** completed | pending | unknown | unsupported_country | … (null for invalid/duplicate rows). */
    status: z.string().nullable(),
    risk_level: z.string().nullable(), risk_score: z.number().nullable(),
    /** Reasons that apply: regulator, government, community, unassigned. */
    reasons: z.array(z.string()), voip_range: z.boolean().nullable(), top_category: z.string().nullable(),
    /** Premium-rate / international shared-cost number (toll-fraud risk); null when not reported. */
    premium_rate: z.boolean().nullable().optional(),
    first_seen: z.string().nullable(), last_seen: z.string().nullable(), sources: z.number().nullable(),
    checked_at: z.string().nullable(), cached: z.boolean().nullable(), billed: z.boolean().nullable(), reason: z.string().nullable(),
    test: z.boolean().optional(),
  });
  server.registerTool("check_spam_reputation", {
    title: "Spam reputation of phone numbers (spends credits)",
    description: `Risk summary for up to ${LOOKUP_MAX} phone numbers from spam and nuisance-call reports (runs the number.spam check only). Per number: risk_level (high | medium | low | no_reports), risk_score 0–100, the reasons behind it, top report category, first/last seen month and the number of independent signal classes. ${SPAM_NOTE} Spends credits; above the confirmation threshold it returns confirmation_required and the USER must approve the amount. Use it to screen callers, leads or sign-ups the user legitimately holds — not to build lists. ${LIMITS_NOTE}`,
    inputSchema: z.object({
      numbers: numbersShape(LOOKUP_MAX).describe(`Phone numbers (ideally E.164 like "+12025550143"). At most ${LOOKUP_MAX}. Test keys: +447700900001 high, …002 no_reports, …003 unknown, …004 pending then medium, …005 unsupported_country.`),
      default_country: defaultCountry, max_age: maxAge, wait_seconds: waitSeconds, confirm_max_cost: confirmMaxCost,
    }),
    outputSchema: z.object({
      lookup_id: z.string(), status: z.string(), results: z.array(SpamOut),
      levels: z.object({ high: z.number(), medium: z.number(), low: z.number(), no_reports: z.number(), not_conclusive: z.number(), invalid: z.number() }),
      cost: MoneyOut.nullable(), balance_after: MoneyOut.nullable(), pending_lookup_id: z.string().nullable(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    const r = await gatedLookup("check_spam_reputation", { ...a, checks: ["number.spam"] });
    if ("result" in r) return r.result;
    const { data } = r;
    const levels = { high: 0, medium: 0, low: 0, no_reports: 0, not_conclusive: 0, invalid: 0 };
    const results = data.results.map((item) => {
      const c = item.checks?.["number.spam"];
      const at = (c?.status === "completed" ? c.attributes : null) ?? {};
      const str = (k: string) => (typeof at[k] === "string" ? (at[k] as string) : null);
      const num = (k: string) => (typeof at[k] === "number" ? (at[k] as number) : null);
      const level = str("risk_level");
      if (String(item.number_status ?? "valid") !== "valid") levels.invalid++;
      else if (level && level in levels && level !== "not_conclusive" && level !== "invalid") levels[level as "high"]++;
      else levels.not_conclusive++;
      return {
        input: item.input, e164: item.e164 ?? null, country: item.country ?? null, number_status: String(item.number_status ?? "valid"),
        status: c ? String(c.status) : null, risk_level: level, risk_score: num("risk_score"),
        reasons: ["regulator", "government", "community", "unassigned"].filter((k) => at[`reason_${k}`] === true),
        voip_range: typeof at.voip_range === "boolean" ? at.voip_range : null, top_category: str("top_category"),
        premium_rate: typeof at.premium_rate === "boolean" ? at.premium_rate : null,
        first_seen: str("first_seen"), last_seen: str("last_seen"), sources: num("sources"),
        checked_at: c?.checked_at ?? null, cached: c ? !!c.cached : null, billed: c ? !!c.billed : null, reason: c?.reason ?? null,
        ...(item.test !== undefined ? { test: item.test } : {}),
      };
    });
    return ok({
      lookup_id: data.id, status: String(data.status), results, levels,
      cost: data.billing?.cost ?? null, balance_after: data.billing?.balance_after ?? null,
      pending_lookup_id: data.status === "pending" ? data.id : null,
    }, `${results.length} numbers: ${levels.high} high, ${levels.medium} medium, ${levels.low} low, ${levels.no_reports} no reports, ` +
      `${levels.not_conclusive} not conclusive (unknown / pending / unsupported country), ${levels.invalid} invalid. ` +
      `Cost ${usd(data.billing?.cost)}. "no reports" does not mean the number is safe.` +
      (data.status === "pending" ? ` Some answers are still pending: lookup ${data.id}.` : ""));
  });

  server.registerTool("create_lookup_job", {
    title: "Start a bulk check (spends credits)",
    description: `Start a bulk check for more than ${LOOKUP_MAX} numbers and/or e-mail addresses (up to ${JOB_MAX} together), when results aren't needed right now, or for bulk-only services (${[...BULK_ONLY_CODES, ...EMAIL_BULK_ONLY_CODES].join(", ")}). Any active service works; each number / e-mail is checked for every service of its kind in checks. Returns a job_id for get_lookup_job. Always requires the USER to approve the cost when above the threshold or above ${LOOKUP_MAX} identifiers. ${LIMITS_NOTE} ${EMAIL_NOTE}`,
    inputSchema: z.object({ numbers: numbersShape(JOB_MAX).optional(), emails: emailsShape(JOB_MAX), checks: checksBulk, default_country: defaultCountry, max_age: maxAge, confirm_max_cost: confirmMaxCost }),
    outputSchema: z.object({ job_id: z.string(), status: z.string(), estimate: EstimateOut, max_cost: MoneyOut, next_step: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    const ids = idsOf(a, JOB_MAX);
    if (ids.error) return ids.error;
    const params = { checks: a.checks, defaultCountry: a.default_country?.toUpperCase(), maxAge: a.max_age };
    const est = await sdk.jobs.estimate({ numbers: ids.numbers, emails: ids.emails, ...params });
    if (est.error) return apiFail(est.error);
    const e = shapeEstimate(est.data);
    const gate = spendGate(e.max_cost.amount, ids.count, thresholdMicro, a.confirm_max_cost, true);
    if (!gate.confirmed) {
      log("create_lookup_job confirmation_required", { n: ids.count, max_cost: e.max_cost.amount });
      return confirmationRequired(e.max_cost.amount, ids.count, thresholdUsd, "create_lookup_job");
    }
    // Same arguments → same idempotency key, so an agent retry does not start (and bill) a second job.
    const idempotencyKey = `mcp-job-${argsHash({ n: ids.numbers, e: ids.emails, ...params, c: gate.maxCost })}`;
    const { data, error } = await sdk.jobs.create({ numbers: ids.numbers, emails: ids.emails, ...params, maxCost: gate.maxCost, idempotencyKey });
    if (error) return apiFail(error);
    log("create_lookup_job", { n: ids.count, job: data.id });
    return ok({
      job_id: data.id, status: String(data.status), estimate: e, max_cost: { amount: gate.maxCost, currency: "USD" },
      next_step: `Call get_lookup_job with job_id "${data.id}" to follow progress and read results.`,
    }, `Job ${data.id} ${data.status}: ${e.valid} valid numbers/e-mails, at most $${gate.maxCost}.`);
  });

  server.registerTool("get_lookup_job", {
    title: "Get bulk job status and results",
    description: "Get a bulk job's status and a page of results (one item per number or e-mail — kind phone/email — with every requested service of its kind in checks). Filter to registered/unregistered/unknown (on the first service, or the one named in service) to save tokens; follow next_cursor for more.",
    inputSchema: z.object({
      job_id: z.string().regex(/^job_[0-9A-Za-z]+$/).describe("The job_id returned by create_lookup_job."),
      registered: z.enum(["true", "false", "null"]).optional().describe('Filter: "true" registered, "false" not registered, "null" unknown.'),
      service: z.string().max(64).optional().describe("Service (code or alias) the registered filter applies to; default: the job's first service."),
      cursor: z.string().optional().describe("next_cursor from a previous call."),
      limit: z.number().int().min(1).max(200).optional().describe("Results per page (default 50, max 200)."),
      response_format: responseFormat,
    }),
    outputSchema: z.object({
      job_id: z.string(), status: z.string(),
      progress: z.object({ total: z.number(), checks_total: z.number(), done: z.number(), conclusive: z.number(), non_billable: z.number() }).partial().nullable(),
      eta_seconds: z.number().nullable(),
      cost: z.object({ estimated_max: MoneyOut, reserved: MoneyOut, charged: MoneyOut, released: MoneyOut }).partial().nullable(),
      results: z.array(ItemOut), has_more: z.boolean(), next_cursor: z.string().nullable(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    const job = await sdk.jobs.get(a.job_id);
    if (job.error) return apiFail(job.error);
    const page = await sdk.jobs.resultsPage(a.job_id, { registered: a.registered, after: a.cursor, limit: a.limit ?? 50,
      ...(a.service ? { service: a.service } : {}) });
    if (page.error) return apiFail(page.error);
    const j: Job = job.data;
    const results = (page.data.data ?? []).map((r) => shapeItem(r, a.response_format === "detailed"));
    const p = j.progress;
    return ok({
      job_id: j.id, status: String(j.status), progress: p ?? null, eta_seconds: j.eta_seconds ?? null, cost: j.cost ?? null,
      results, has_more: page.data.has_more, next_cursor: page.data.next_cursor ?? null,
    }, `Job ${j.id} ${j.status}${p ? ` (${p.done}/${p.total} done)` : ""}. ${results.length} results on this page${page.data.has_more ? "; more via next_cursor" : ""}.`);
  });

  server.registerTool("list_services", {
    title: "List available services (free)",
    description: "List the services this key can use: code, platform, input type (phone → numbers, email → emails), real time or bulk only, attributes, countries and prices (per number/e-mail and service; non-conclusive results are free). Platform names are descriptive only; no affiliation.",
    inputSchema: z.object({}),
    outputSchema: z.object({ services: z.array(ServiceOut), realtime: z.array(z.string()), bulk_only: z.array(z.string()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const { data, error } = await sdk.services();
    if (error) return apiFail(error);
    const services = (data.data ?? []).map(shapeService);
    const realtime = services.filter((s) => s.realtime && s.status === "active").map((s) => s.code);
    const bulkOnly = services.filter((s) => !s.realtime && s.status === "active").map((s) => s.code);
    return ok({ services, realtime, bulk_only: bulkOnly },
      `${services.length} services. Real time: ${realtime.join(", ") || "none"}. Bulk only: ${bulkOnly.join(", ") || "none"}.`);
  });

  server.registerTool("get_account", {
    title: "Account balance and limits",
    description: "Show balance, reserved credit, today's usage, remaining daily caps and rate limits.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      org_id: z.string(), balance: MoneyOut, reserved: MoneyOut,
      today: z.record(z.string(), z.unknown()).nullable(), limits: z.record(z.string(), z.unknown()).nullable(),
      confirm_above: MoneyOut,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const [acct, limits] = await Promise.all([sdk.account.get(), sdk.limits.get()]);
    if (acct.error) return apiFail(acct.error);
    const a = acct.data;
    return ok({
      org_id: a.org_id, balance: a.balance, reserved: a.reserved, today: a.today ?? null,
      limits: limits.error ? null : limits.data, confirm_above: { amount: thresholdUsd, currency: "USD" },
    }, `Balance ${usd(a.balance)} (reserved ${usd(a.reserved)}).`);
  });

  return server;
}

function shapeLookup(l: Lookup, detailed: boolean) {
  // Metadata is deliberately never copied into tool output.
  return {
    lookup_id: l.id,
    status: String(l.status),
    summary: l.summary,
    results: l.results.map((r) => shapeItem(r, detailed)),
    cost: l.billing?.cost ?? null,
    balance_after: l.billing?.balance_after ?? null,
    pending_lookup_id: l.status === "pending" ? l.id : null,
  };
}
