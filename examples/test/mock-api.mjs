// A small, offline stand-in for the MobileValidate API, used by the example tests. It answers the documented magic
// numbers and e-mail addresses the way test mode does, enforces the sandbox-key rules, and returns errors in the
// real contract shape. It is NOT the real API: run the tests with LIVE=1 to hit https://api.mobilevalidate.com.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const SANDBOX_PUBLIC_KEY = "mv_test_publicSandboxn9ZgneuhR1B9CRfKG3fulym";

const MAGIC_NUMBERS = {
  "+447700900001": { registered: true, status: "completed" },
  "+447700900002": { registered: false, status: "completed" },
  "+447700900003": { registered: null, status: "unknown", reason: "UPSTREAM_TIMEOUT" },
  "+447700900004": { registered: true, status: "completed", pending: true },
  "+447700900005": { registered: null, status: "unsupported_country" },
  "+447700900006": { registered: true, status: "completed", business: true },
  "+447700900429": { error: "rate_limited" },
  "+447700900402": { error: "insufficient_balance" },
};
const EMAIL_DOMAIN = "test.mobilevalidate.com";
const MAGIC_EMAILS = {
  registered: { registered: true, status: "completed" },
  "not-registered": { registered: false, status: "completed" },
  unknown: { registered: null, status: "unknown", reason: "UPSTREAM_TIMEOUT" },
  pending: { registered: true, status: "completed", pending: true },
  unsupported: { registered: null, status: "unknown", reason: "UNSUPPORTED_PROVIDER" },
  "rate-limited": { error: "rate_limited" },
  "no-balance": { error: "insufficient_balance" },
};
const ALIASES = {
  whatsapp: "whatsapp.registered", telegram: "telegram.registered", viber: "viber.registered",
  carrier: "network.carrier", email: "email.valid",
};
const SERVICES = {
  "whatsapp.registered": { platform: "WhatsApp", input: "phone" },
  "whatsapp.business": { platform: "WhatsApp", input: "phone" },
  "telegram.registered": { platform: "Telegram", input: "phone" },
  "viber.registered": { platform: "Viber", input: "phone" },
  "network.carrier": { platform: "Mobile network", input: "phone", attributes: true },
  "email.valid": { platform: "E-mail", input: "email" },
};
const ERRORS = {
  invalid_request: 400, unauthorized: 401, insufficient_balance: 402, service_disabled: 403, sandbox_magic_only: 403,
  not_found: 404, rate_limited: 429, internal_error: 500,
};
const RETRYABLE = new Set(["rate_limited", "internal_error"]);
const EMAIL_TYPOS = { "gmial.com": "gmail.com", "gmail.con": "gmail.com", "hotmial.com": "hotmail.com", "yahoo.con": "yahoo.com" };

class ApiError extends Error {
  constructor(code, message, { param = null, suggestion = null } = {}) {
    super(message);
    Object.assign(this, { code, param, suggestion });
  }
}

const rid = () => `req_${randomBytes(8).toString("hex")}`;
const now = () => new Date().toISOString();

function normalizeNumber(raw, defaultCountry) {
  const s = String(raw).replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(s)) return { e164: s };
  if (/^0\d{9,10}$/.test(s) && defaultCountry === "GB") return { e164: "+44" + s.slice(1) };
  const suggestion = /^\d{8,15}$/.test(s)
    ? "Add the country code in international format, e.g. +44 7700 900001, or send default_country."
    : "Use international format with a leading + and the country code, e.g. +44 7700 900001.";
  return { e164: null, suggestion };
}

function normalizeEmail(raw) {
  const e = String(raw).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) return { email: null, suggestion: "This is not a valid e-mail address (expected name@domain.com)." };
  const domain = e.split("@")[1];
  if (EMAIL_TYPOS[domain]) return { email: null, suggestion: `The domain looks mistyped. Did you mean @${EMAIL_TYPOS[domain]}?` };
  return { email: e };
}

/** Test-mode answer for one identifier + service. */
function answer(kind, id, service) {
  let magic = kind === "phone" ? MAGIC_NUMBERS[id] : id.endsWith(`@${EMAIL_DOMAIN}`) ? MAGIC_EMAILS[id.split("@")[0]] : undefined;
  if (!magic) {
    // Test keys: a fake but stable answer for any other identifier.
    const h = createHash("sha256").update(`${id}|${service}`).digest()[0];
    magic = { registered: h % 2 === 0, status: "completed" };
  }
  const base = {
    service, status: magic.status, registered: magic.registered, attributes: null,
    confidence: magic.status === "completed" ? "high" : null, confidence_score: magic.status === "completed" ? 0.95 : null,
    checked_at: magic.status === "completed" ? now() : null, cached: false, age_seconds: 0, billed: false,
    reason: magic.reason ?? (magic.status === "unsupported_country" ? "UNSUPPORTED_COUNTRY" : null), poll_after_ms: null,
  };
  if (service === "network.carrier") {
    if (id === "+447700900002" || id === "+447700900003") return { ...base, status: "unknown", registered: null, reason: "UPSTREAM_TIMEOUT", confidence: null, confidence_score: null };
    return { ...base, status: "completed", registered: true, reason: null, attributes: { line_type: "mobile", carrier: "Test Carrier", country: "GB" } };
  }
  if (service === "whatsapp.business") base.attributes = { business: !!magic.business };
  return { ...base, pending: !!magic.pending };
}

function resolveChecks(checks, hasNumbers, hasEmails) {
  const list = (checks?.length ? checks : ["whatsapp"]).map((c) => ALIASES[c] ?? c);
  list.forEach((c, i) => {
    if (!SERVICES[c]) throw new ApiError("service_disabled", `Service ${c} is not available for this key.`, {
      param: `checks[${i}]`, suggestion: "Available in this mock: whatsapp, telegram, viber, carrier, email.",
    });
  });
  if (hasEmails && !list.some((c) => SERVICES[c].input === "email")) {
    throw new ApiError("invalid_request", "E-mail addresses need an e-mail check.", { param: "checks", suggestion: 'Add "email" to checks.' });
  }
  if (hasNumbers && !list.some((c) => SERVICES[c].input === "phone")) {
    throw new ApiError("invalid_request", "Numbers need a phone check.", { param: "checks", suggestion: 'Add "whatsapp" to checks.' });
  }
  return list;
}

function buildRows(body, sandbox, maxRows) {
  const numbers = body.numbers ?? [];
  const emails = body.emails ?? [];
  if (!numbers.length && !emails.length) throw new ApiError("invalid_request", "Send numbers and/or emails.", { param: "numbers" });
  if (numbers.length + emails.length > maxRows) {
    throw new ApiError("invalid_request", `At most ${maxRows} numbers and e-mails per request with this key.`, {
      param: "numbers", suggestion: sandbox ? "The sandbox key allows jobs of up to 10 rows; get a test key for more." : null,
    });
  }
  const checks = resolveChecks(body.checks, numbers.length > 0, emails.length > 0);
  const rows = [];
  const seen = new Set();
  for (const input of numbers) {
    const n = normalizeNumber(input, body.default_country);
    const row = { kind: "phone", input, e164: n.e164, country: n.e164?.startsWith("+44") ? "GB" : null, test: true };
    if (sandbox && !(n.e164 && MAGIC_NUMBERS[n.e164])) throw sandboxError("numbers");
    if (!n.e164) rows.push({ ...row, number_status: "invalid_number", suggestion: n.suggestion });
    else if (seen.has(n.e164)) rows.push({ ...row, number_status: "duplicate" });
    else {
      seen.add(n.e164);
      const err = MAGIC_NUMBERS[n.e164]?.error;
      if (err) throw magicError(err);
      rows.push({ ...row, number_status: "valid", _checks: checks.filter((c) => SERVICES[c].input === "phone").map((c) => answer("phone", n.e164, c)) });
    }
  }
  for (const input of emails) {
    const e = normalizeEmail(input);
    const row = { kind: "email", input, email: e.email, e164: null, country: null, test: true };
    const local = e.email?.endsWith(`@${EMAIL_DOMAIN}`) ? e.email.split("@")[0] : null;
    if (sandbox && !(local && MAGIC_EMAILS[local])) throw sandboxError("emails");
    if (!e.email) rows.push({ ...row, email_status: "invalid_email", suggestion: e.suggestion });
    else if (seen.has(e.email)) rows.push({ ...row, email_status: "duplicate" });
    else {
      seen.add(e.email);
      const err = local && MAGIC_EMAILS[local]?.error;
      if (err) throw magicError(err);
      rows.push({ ...row, email_status: "valid", _checks: checks.filter((c) => SERVICES[c].input === "email").map((c) => answer("email", e.email, c)) });
    }
  }
  return { rows, checks };
}

const sandboxError = (param) => new ApiError("sandbox_magic_only", "The public sandbox key only answers the documented test values.", {
  param, suggestion: "Use a test value such as +447700900001 (see mobilevalidate.com/docs/test-values), or get a personal test key at mobilevalidate.com/get-test-key.",
});
const magicError = (code) => code === "rate_limited"
  ? new ApiError("rate_limited", "Too many requests (test value).", { suggestion: "Wait for Retry-After seconds, then retry." })
  : new ApiError("insufficient_balance", "Your balance is too low for this request (test value).", { suggestion: "Top up your balance, or lower max_cost." });

/** Render rows: pending checks stay pending until `completed` is true. */
function renderRow(row, completed) {
  const { _checks, ...rest } = row;
  if (!_checks) return rest;
  const checks = {};
  for (const c of _checks) {
    const { pending, ...v } = c;
    checks[c.service] = pending && !completed
      ? { ...v, status: "pending", registered: null, confidence: null, confidence_score: null, checked_at: null, poll_after_ms: 1000 }
      : v;
  }
  return { ...rest, checks };
}

function summary(rows) {
  const s = { total: rows.length, registered: 0, not_registered: 0, unknown: 0, pending: 0, invalid: 0, suppressed: 0, by_service: {} };
  for (const r of rows) {
    if (!r.checks) { if (/invalid/.test(r.number_status ?? r.email_status ?? "")) s.invalid++; continue; }
    Object.values(r.checks).forEach((c, i) => {
      const b = (s.by_service[c.service] ??= { completed: 0, registered: 0, not_registered: 0, unknown: 0, pending: 0 });
      const key = c.status === "pending" ? "pending" : c.registered === true ? "registered" : c.registered === false ? "not_registered" : "unknown";
      if (c.status !== "pending") b.completed++;
      b[key]++;
      if (i === 0) s[key]++;
    });
  }
  return s;
}

function renderLookup(l, requestId) {
  const results = l.rows.map((r) => renderRow(r, l.completed));
  const pending = results.some((r) => r.checks && Object.values(r.checks).some((c) => c.status === "pending"));
  return {
    object: "lookup", id: l.id, status: pending ? "pending" : "completed", livemode: false, created_at: l.created_at,
    results, summary: summary(results),
    billing: { billed_units: 0, cost: { amount: "0", currency: "USD" }, balance_after: { amount: "10.00", currency: "USD" } },
    next: pending ? { poll_url: `/v1/lookups/${l.id}`, poll_after_ms: 1000 } : null, request_id: requestId,
  };
}

function renderJob(j) {
  const done = j.polls >= 1;
  return {
    object: "job", id: j.id, status: done ? "completed" : "running", created_at: j.created_at, checks: j.checks,
    progress: { total: j.rows.length, checks_total: j.rows.length * j.checks.length, done: done ? j.rows.length : 0, conclusive: done ? j.rows.length : 0, non_billable: 0 },
    eta_seconds: done ? 0 : 5,
    cost: Object.fromEntries(["estimated_max", "reserved", "charged", "released"].map((k) => [k, { amount: "0", currency: "USD" }])),
    retention_days: 30,
  };
}

/**
 * Start the mock API. Returns { url, close, requests } where `requests` records method, path and key per call.
 * @param {{ port?: number }} [opts]
 */
export async function startMockApi(opts = {}) {
  const lookups = new Map();
  const jobs = new Map();
  const requests = [];

  const server = createServer(async (req, res) => {
    const requestId = rid();
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": requestId, ...(status === 429 ? { "retry-after": "0" } : {}) });
      res.end(body === null ? "" : JSON.stringify(body));
    };
    const fail = (e) => {
      const code = e instanceof ApiError ? e.code : "internal_error";
      const status = ERRORS[code] ?? 500;
      send(status, { error: {
        code, message: e.message, status, retryable: RETRYABLE.has(code), param: e.param ?? null,
        ...(e.suggestion ? { suggestion: e.suggestion } : {}), doc_url: `https://mobilevalidate.com/docs/errors#${code}`, request_id: requestId,
      } });
    };
    try {
      const url = new URL(req.url, "http://mock");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      requests.push({ method: req.method, path: url.pathname, key, idempotencyKey: req.headers["idempotency-key"] ?? null });

      if (url.pathname === "/v1/health") return send(200, { ok: true });
      if (!/^mv_(test|live|agent)_[0-9A-Za-z]{36}$/.test(key)) {
        throw new ApiError("unauthorized", "Missing or invalid API key.", { suggestion: "Send Authorization: Bearer mv_test_… (see mobilevalidate.com/docs/authentication)." });
      }
      const sandbox = key === SANDBOX_PUBLIC_KEY;
      const body = raw ? JSON.parse(raw) : {};
      let m;

      if (req.method === "POST" && url.pathname === "/v1/lookup") {
        const { rows } = buildRows(body, sandbox, 100);
        const l = { id: `lkp_${randomBytes(6).toString("hex")}`, created_at: now(), rows, completed: false };
        lookups.set(l.id, l);
        const out = renderLookup(l, requestId);
        return send(out.status === "pending" ? 202 : 200, out);
      }
      if (req.method === "GET" && (m = /^\/v1\/lookups\/([^/]+)$/.exec(url.pathname))) {
        const l = lookups.get(m[1]);
        if (!l) throw new ApiError("not_found", "No such lookup.");
        l.completed = true; // the pending magic value completes on the first poll
        return send(200, renderLookup(l, requestId));
      }
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const { rows, checks } = buildRows(body, sandbox, sandbox ? 10 : 50_000);
        const j = { id: `job_${randomBytes(6).toString("hex")}`, created_at: now(), rows, checks, polls: 0 };
        jobs.set(j.id, j);
        return send(201, { ...renderJob(j), status: "queued" });
      }
      if (req.method === "GET" && (m = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname))) {
        const j = jobs.get(m[1]);
        if (!j) throw new ApiError("not_found", "No such job.");
        const out = renderJob(j);
        j.polls++;
        return send(200, out);
      }
      if (req.method === "GET" && (m = /^\/v1\/jobs\/([^/]+)\/results$/.exec(url.pathname))) {
        const j = jobs.get(m[1]);
        if (!j) throw new ApiError("not_found", "No such job.");
        const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 100));
        const start = Number(url.searchParams.get("after") ?? 0);
        const page = j.rows.slice(start, start + limit).map((r) => renderRow(r, true));
        const hasMore = start + limit < j.rows.length;
        return send(200, { object: "list", data: page, has_more: hasMore, next_cursor: hasMore ? String(start + limit) : null });
      }
      if (req.method === "GET" && url.pathname === "/v1/services") {
        const data = Object.entries(SERVICES).map(([code, s]) => ({
          object: "service", code, name: `${s.platform} check`, platform: s.platform, family: s.input === "email" ? "email" : "messaging",
          input_type: s.input, result_kind: s.attributes ? "attributes" : "boolean", attributes: [], realtime: true, batch: true,
          status: "active", beta: code === "network.carrier", countries: [],
          prices: { realtime: { amount: "0.0010", currency: "USD" }, batch: { amount: "0.0008", currency: "USD" } },
        }));
        return send(200, { object: "list", data, has_more: false });
      }
      throw new ApiError("not_found", `No route ${req.method} ${url.pathname}.`, { suggestion: "See mobilevalidate.com/docs/api-reference." });
    } catch (e) {
      fail(e);
    }
  });

  await new Promise((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

// `node test/mock-api.mjs` runs it standalone (prints the URL).
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = await startMockApi({ port: Number(process.env.PORT ?? 0) });
  console.log(api.url);
}
