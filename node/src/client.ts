import { InvalidArgumentError, MobileValidateError } from "./errors.ts";
import { HttpClient, defaultSleep, type FetchLike, type RawResponse, type RequestOptions } from "./http.ts";
import { SANDBOX_PUBLIC_KEY } from "./sandbox.ts";
import type {
  Account, CallOptions, CheckOptions, DownloadFormat, DownloadRow, DurationInput, Estimate, Job, JobDownload, JobCreateParams, JobResultsParams, Lookup, LookupParams, Money, MoneyInput,
  Page, Result, ResultItem, Service, WebhookEndpoint, WebhookEvent, WebhookEventType,
} from "./types.ts";
import { DEFAULT_BASE_URL } from "./version.ts";
import { verifyWebhook, type VerifyOptions, type WebhookHeaders } from "./webhooks.ts";

export interface MobileValidateOptions {
  /** API key (`mv_live_…`, `mv_test_…`, `mv_agent_…`). Defaults to env MOBILEVALIDATE_API_KEY. */
  apiKey?: string;
  /**
   * Use the public sandbox key (no signup; only the documented magic numbers and e-mail addresses, per-IP limits,
   * never billed). Ignores MOBILEVALIDATE_API_KEY; an explicit `apiKey` still wins.
   */
  sandbox?: boolean;
  /** Default https://api.mobilevalidate.com (env MOBILEVALIDATE_BASE_URL also honoured). */
  baseUrl?: string;
  /** Per-HTTP-request timeout in ms (default 30 000). Server long-poll time is added automatically. Per call: `timeoutMs`. */
  timeoutMs?: number;
  /** Overall wait budget for `whatsapp.check` polling in ms (default 60 000). */
  waitTimeoutMs?: number;
  /** Retries for retryable failures (default 2), with jittered backoff; Retry-After is honoured. Per call: `maxRetries`. */
  maxRetries?: number;
  /** Throw MobileValidateError instead of returning `{ data: null, error }`. */
  throwOnError?: boolean;
  /** Custom fetch (tests, proxies). */
  fetch?: FetchLike;
  /** @internal Test hook for backoff/poll sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_SERVER_WAIT_S = 30;

/** Read an env var without depending on Node (works on Deno/edge, returns undefined there if absent). */
function env(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env?: { get(k: string): string | undefined } } };
  try {
    return g.process?.env?.[name] ?? g.Deno?.env?.get(name);
  } catch {
    return undefined;
  }
}

export function toMoney(v: MoneyInput): Money {
  if (typeof v === "object") return v;
  const amount = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new InvalidArgumentError({ code: "invalid_argument", message: "maxCost must be a non-negative decimal", param: "max_cost" });
  return { amount, currency: "USD" };
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
export function toSeconds(v: DurationInput): number {
  if (typeof v === "number") return Math.max(0, Math.floor(v));
  const m = /^(\d+)\s*([smhd]?)$/.exec(v.trim());
  if (!m) throw new InvalidArgumentError({ code: "invalid_argument", message: "maxAge must be seconds or like 30s, 15m, 24h, 7d", param: "max_age" });
  return Number(m[1]) * UNITS[m[2] || "s"]!;
}

function clampWait(w: number | undefined, dflt: number): number {
  return Math.min(MAX_SERVER_WAIT_S, Math.max(0, Math.floor(w ?? dflt)));
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function jobBody(p: JobCreateParams) {
  return compact({
    numbers: p.numbers,
    emails: p.emails,
    upload_id: p.uploadId,
    checks: p.checks,
    default_country: p.defaultCountry,
    max_age: p.maxAge === undefined ? undefined : toSeconds(p.maxAge),
    max_cost: p.maxCost === undefined ? undefined : toMoney(p.maxCost),
    webhook_endpoint_id: p.webhookEndpointId,
    metadata: p.metadata,
  });
}

export class MobileValidate {
  readonly whatsapp: WhatsApp;
  readonly lookups: Lookups;
  readonly jobs: Jobs;
  readonly account: AccountResource;
  readonly limits: LimitsResource;
  readonly usage: UsageResource;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly webhooks: Webhooks;

  /** @internal */ readonly http: HttpClient;
  /** @internal */ readonly throwOnError: boolean;
  /** @internal */ readonly waitTimeoutMs: number;
  /** @internal */ readonly sleep: (ms: number) => Promise<void>;

  static readonly MobileValidateError = MobileValidateError;
  /** The public sandbox key (also exported as `SANDBOX_PUBLIC_KEY`). */
  static readonly SANDBOX_PUBLIC_KEY = SANDBOX_PUBLIC_KEY;
  /** True when this client uses the public sandbox key. */
  readonly sandbox: boolean;

  constructor(opts: MobileValidateOptions = {}) {
    const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.throwOnError = opts.throwOnError ?? false;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
    const apiKey = opts.apiKey ?? (opts.sandbox ? SANDBOX_PUBLIC_KEY : env("MOBILEVALIDATE_API_KEY")) ?? null;
    this.sandbox = apiKey === SANDBOX_PUBLIC_KEY;
    this.http = new HttpClient({
      apiKey,
      baseUrl: opts.baseUrl ?? env("MOBILEVALIDATE_BASE_URL") ?? DEFAULT_BASE_URL,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxRetries: opts.maxRetries ?? 2,
      fetch: fetchImpl,
      sleep: this.sleep,
      random: Math.random,
    });
    this.whatsapp = new WhatsApp(this);
    this.lookups = new Lookups(this);
    this.jobs = new Jobs(this);
    this.account = new AccountResource(this);
    this.limits = new LimitsResource(this);
    this.usage = new UsageResource(this);
    this.webhookEndpoints = new WebhookEndpoints(this);
    this.webhooks = new Webhooks();
  }

  /**
   * Check 1–100 numbers and/or e-mail addresses for one or more services in real time. Waits for asynchronous
   * results transparently (long-polling) until all items are completed or the wait budget runs out; then the lookup
   * is returned as-is with `status: "pending"`. Bulk-only services are refused with `service_disabled` — use
   * `jobs.create()` for them. Phone services apply to `numbers`, e-mail services to `emails`; result rows are numbers
   * first, then e-mails (`item.kind`).
   *
   * @example const { data } = await mv.lookup(["+447700900001"], { checks: ["whatsapp", "telegram", "viber"] });
   * @example const { data } = await mv.lookup({ emails: ["registered@test.mobilevalidate.com"], checks: ["email"] });
   */
  lookup(numbers: string | string[], opts?: CheckOptions): Promise<Result<Lookup>>;
  lookup(params: LookupParams): Promise<Result<Lookup>>;
  lookup(input: string | string[] | LookupParams, opts: CheckOptions = {}): Promise<Result<Lookup>> {
    if (typeof input === "string" || Array.isArray(input)) return runLookup(this, { numbers: Array.isArray(input) ? input : [input] }, opts);
    const { numbers, emails, ...rest } = input ?? {};
    return runLookup(this, { numbers, emails }, rest);
  }

  /** Service catalog for this key (GET /v1/services): codes, real-time/batch, prices, attributes. */
  services(opts: CallOptions = {}): Promise<Result<Page<Service>>> {
    return this.call<Page<Service>>("GET", "/v1/services", callOpts(opts));
  }

  /** @internal Issue a request and apply the result/throw policy. */
  async call<T>(method: string, path: string, opts?: RequestOptions): Promise<Result<T>> {
    const { result } = await this.http.request<T>(method, path, opts);
    return this.finish(result);
  }

  /** @internal */
  finish<T>(result: Result<T>): Result<T> {
    if (result.error && this.throwOnError) throw result.error;
    return result;
  }

  /** @internal Wrap argument validation errors in the result/throw policy. */
  guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return fn().catch((e: unknown) => {
        if (e instanceof MobileValidateError) return this.finish<T>({ data: null, error: e, requestId: e.requestId });
        throw e;
      });
    } catch (e) {
      if (e instanceof MobileValidateError) return Promise.resolve(this.finish<T>({ data: null, error: e, requestId: e.requestId }));
      throw e;
    }
  }
}

/** Per-call options shared by every method. */
function callOpts(o: CallOptions): Pick<RequestOptions, "signal" | "timeoutMs" | "maxRetries"> {
  return { signal: o.signal, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries };
}

function filenameOf(disposition: string | null): string | null {
  const m = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return m ? m[1]! : null;
}

async function* ndjsonRows(body: ReadableStream<Uint8Array>): AsyncGenerator<DownloadRow, void, undefined> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as DownloadRow;
    }
    if (done) break;
  }
  if (buf.trim()) yield JSON.parse(buf) as DownloadRow;
}

function toDownload<F extends DownloadFormat>(res: Response, format: F): JobDownload<F> {
  const body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const base = {
    format, contentType: res.headers.get("content-type"), filename: filenameOf(res.headers.get("content-disposition")),
    body, text: () => new Response(body).text(),
  };
  return (format === "ndjson" ? { ...base, rows: () => ndjsonRows(body) } : base) as unknown as JobDownload<F>;
}

const TERMINAL_JOB = new Set(["completed", "failed", "cancelled"]);

abstract class Resource {
  protected readonly c: MobileValidate;
  constructor(client: MobileValidate) {
    this.c = client;
  }
}

/** POST /v1/lookup + transparent long-polling (shared by `lookup()` and `whatsapp.check()`). */
function runLookup(c: MobileValidate, ids: { numbers?: string[]; emails?: string[] }, opts: CheckOptions): Promise<Result<Lookup>> {
  return c.guard(async () => {
    if (!ids.numbers?.length && !ids.emails?.length) {
      throw new InvalidArgumentError({ code: "invalid_argument", message: "Provide at least one number or e-mail address", param: "numbers" });
    }
    const deadline = Date.now() + (opts.waitTimeoutMs ?? c.waitTimeoutMs);
    const wait = clampWait(opts.wait, 10);
    const body = compact({
      numbers: ids.numbers,
      emails: ids.emails,
      checks: opts.checks,
      default_country: opts.defaultCountry,
      max_age: opts.maxAge === undefined ? undefined : toSeconds(opts.maxAge),
      wait,
      max_cost: opts.maxCost === undefined ? undefined : toMoney(opts.maxCost),
      metadata: opts.metadata,
      webhook_endpoint_id: opts.webhookEndpointId,
    });
    const first = await c.http.request<Lookup>("POST", "/v1/lookup", {
      body, idempotencyKey: opts.idempotencyKey, extraTimeoutMs: wait * 1000, ...callOpts(opts),
    });
    let result = first.result;
    // wait: 0 means "return immediately, I'll poll or use a webhook".
    while (result.data && result.data.status === "pending" && wait > 0 && !opts.signal?.aborted) {
      const remainingS = Math.floor((deadline - Date.now()) / 1000);
      if (remainingS < 1) break;
      const pollWait = Math.min(MAX_SERVER_WAIT_S, remainingS);
      const next = await c.http.request<Lookup>("GET", `/v1/lookups/${encodeURIComponent(result.data.id)}`, {
        query: { wait: pollWait }, extraTimeoutMs: pollWait * 1000, ...callOpts(opts),
      });
      if (next.result.error) {
        // Keep the last good (pending) lookup if polling fails transiently; surface hard errors.
        if (next.result.error.retryable) break;
        result = next.result;
        break;
      }
      const prev = result.data;
      result = next.result;
      // Guard against a server that ignores ?wait: back off using its hint.
      if (result.data?.status === "pending") {
        const hint = result.data.next?.poll_after_ms ?? prev.next?.poll_after_ms ?? 1000;
        const pause = Math.min(hint, Math.max(0, deadline - Date.now()));
        if (pause > 0) await c.sleep(pause);
      }
    }
    return c.finish(result);
  });
}

class WhatsApp extends Resource {
  /**
   * Check 1–100 numbers (default check: WhatsApp). Same as `mv.lookup()`, kept for compatibility.
   *
   * @example const { data, error } = await mv.whatsapp.check("+447700900001");
   */
  check(numbers: string | string[], opts: CheckOptions = {}): Promise<Result<Lookup>> {
    return runLookup(this.c, { numbers: Array.isArray(numbers) ? numbers : [numbers] }, opts);
  }
}

class Lookups extends Resource {
  /** Fetch a lookup; `wait` (0–30 s) long-polls until it completes. */
  get(id: string, opts: { wait?: number } & CallOptions = {}): Promise<Result<Lookup>> {
    const wait = clampWait(opts.wait, 0);
    return this.c.call<Lookup>("GET", `/v1/lookups/${encodeURIComponent(id)}`, {
      query: { wait: wait || undefined }, extraTimeoutMs: wait * 1000, ...callOpts(opts),
    });
  }
}

class Jobs extends Resource {
  /** Create a bulk job (≤ 50 000 numbers and/or e-mails as JSON, or an `uploadId`). */
  create(params: JobCreateParams): Promise<Result<Job>> {
    return this.c.guard(() => this.c.call<Job>("POST", "/v1/jobs", {
      body: jobBody(params), idempotencyKey: params.idempotencyKey, ...callOpts(params),
    }));
  }

  /** Free pre-flight: counts and maximum cost, no charge. */
  estimate(params: JobCreateParams): Promise<Result<Estimate>> {
    return this.c.guard(() => this.c.call<Estimate>("POST", "/v1/jobs/estimate", {
      body: jobBody(params), idempotencyKey: params.idempotencyKey, ...callOpts(params),
    }));
  }

  get(id: string, opts: { wait?: number } & CallOptions = {}): Promise<Result<Job>> {
    const wait = clampWait(opts.wait, 0);
    return this.c.call<Job>("GET", `/v1/jobs/${encodeURIComponent(id)}`, {
      query: { wait: wait || undefined }, extraTimeoutMs: wait * 1000, ...callOpts(opts),
    });
  }

  /**
   * Wait until a job is `completed`, `failed` or `cancelled` (server long-polling, 30 s per request) or the budget
   * runs out; then returns the job as it is. `timeoutMs` here is the overall budget (default 10 minutes).
   *
   * @example const { data: job } = await mv.jobs.wait(created.id);
   */
  wait(id: string, opts: { timeoutMs?: number; signal?: AbortSignal; maxRetries?: number } = {}): Promise<Result<Job>> {
    return this.c.guard<Job>(async () => {
      const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
      let res: RawResponse<Job> = await this.c.http.request<Job>("GET", `/v1/jobs/${encodeURIComponent(id)}`, { signal: opts.signal, maxRetries: opts.maxRetries });
      while (res.result.data && !TERMINAL_JOB.has(String(res.result.data.status)) && !opts.signal?.aborted) {
        const left = Math.floor((deadline - Date.now()) / 1000);
        if (left < 1) break;
        const w = Math.min(MAX_SERVER_WAIT_S, left);
        const prev = res.result.data;
        const next = await this.c.http.request<Job>("GET", `/v1/jobs/${encodeURIComponent(id)}`, {
          query: { wait: w }, extraTimeoutMs: w * 1000, signal: opts.signal, maxRetries: opts.maxRetries,
        });
        if (next.result.error) {
          if (next.result.error.retryable) break; // keep the last good state
          return this.c.finish<Job>(next.result);
        }
        res = next;
        // Guard against a server that ignores ?wait (never spin).
        const cur = res.result.data as Job;
        if (!TERMINAL_JOB.has(String(cur.status)) && cur.status === prev.status) {
          const pause = Math.min(2000, Math.max(0, deadline - Date.now()));
          if (pause > 0) await this.c.sleep(pause);
        }
      }
      return this.c.finish<Job>(res.result);
    });
  }

  /** One page of results. */
  resultsPage(id: string, params: JobResultsParams = {}): Promise<Result<Page<ResultItem>>> {
    return this.c.call<Page<ResultItem>>("GET", `/v1/jobs/${encodeURIComponent(id)}/results`, {
      query: {
        registered: params.registered === undefined ? undefined : String(params.registered),
        status: params.status, service: params.service, limit: params.limit, after: params.after,
      },
      ...callOpts(params),
    });
  }

  /**
   * Iterate over all result items, following cursors. Request errors are thrown (MobileValidateError).
   * @example for await (const item of mv.jobs.results(jobId, { registered: true })) { … }
   */
  async *results(id: string, params: JobResultsParams = {}): AsyncGenerator<ResultItem, void, undefined> {
    let after = params.after;
    for (;;) {
      const { result } = await this.c.http.request<Page<ResultItem>>("GET", `/v1/jobs/${encodeURIComponent(id)}/results`, {
        query: {
          registered: params.registered === undefined ? undefined : String(params.registered),
          status: params.status, service: params.service, limit: params.limit, after,
        },
        ...callOpts(params),
      });
      if (result.error) throw result.error;
      yield* result.data.data ?? [];
      if (!result.data.has_more || !result.data.next_cursor) return;
      after = result.data.next_cursor;
    }
  }

  /**
   * Stream the whole result file (one line per row, in input order) as CSV (default) or NDJSON.
   * @example const { data } = await mv.jobs.download(jobId); const csv = await data!.text();
   * @example const { data } = await mv.jobs.download(jobId, { format: "ndjson" }); for await (const row of data!.rows()) { … }
   */
  async download<F extends DownloadFormat = "csv">(id: string, opts: { format?: F } & CallOptions = {}): Promise<Result<JobDownload<F>>> {
    const format = (opts.format ?? "csv") as F;
    const { result } = await this.c.http.request<Response>("GET", `/v1/jobs/${encodeURIComponent(id)}/download`, {
      query: { format }, stream: true, accept: format === "csv" ? "text/csv" : "application/x-ndjson", ...callOpts(opts),
    });
    if (result.error) return this.c.finish<JobDownload<F>>(result);
    return this.c.finish<JobDownload<F>>({ data: toDownload(result.data, format), error: null, requestId: result.requestId });
  }

  /** Cancel a running job (unsubmitted items are released) or purge a finished job's data. */
  cancel(id: string, opts: CallOptions = {}): Promise<Result<Job>> {
    return this.c.call<Job>("DELETE", `/v1/jobs/${encodeURIComponent(id)}`, callOpts(opts));
  }
}

class AccountResource extends Resource {
  get(opts: CallOptions = {}): Promise<Result<Account>> {
    return this.c.call<Account>("GET", "/v1/account", callOpts(opts));
  }
}

class LimitsResource extends Resource {
  get(opts: CallOptions = {}): Promise<Result<Record<string, unknown>>> {
    return this.c.call("GET", "/v1/limits", callOpts(opts));
  }
}

class UsageResource extends Resource {
  /** `from`/`to` as YYYY-MM-DD. */
  get(params: { from: string; to: string; groupBy?: "day" | "service" } & CallOptions): Promise<Result<Record<string, unknown>>> {
    return this.c.call("GET", "/v1/usage", {
      query: { from: params.from, to: params.to, group_by: params.groupBy }, ...callOpts(params),
    });
  }
}

class WebhookEndpoints extends Resource {
  /** Register an https endpoint. It stays inactive until the ownership challenge succeeds. The secret is shown once. */
  create(params: { url: string; events: WebhookEventType[]; idempotencyKey?: string } & CallOptions): Promise<Result<WebhookEndpoint & { secret?: string }>> {
    return this.c.call("POST", "/v1/webhook_endpoints", {
      body: { url: params.url, events: params.events }, idempotencyKey: params.idempotencyKey, ...callOpts(params),
    });
  }

  list(opts: CallOptions = {}): Promise<Result<Page<WebhookEndpoint>>> {
    return this.c.call("GET", "/v1/webhook_endpoints", callOpts(opts));
  }

  delete(id: string, opts: CallOptions = {}): Promise<Result<null>> {
    return this.c.call("DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`, callOpts(opts));
  }

  /** Queue a test event to the endpoint. */
  test(id: string, opts: CallOptions = {}): Promise<Result<Record<string, unknown> | null>> {
    return this.c.call("POST", `/v1/webhook_endpoints/${encodeURIComponent(id)}/test`, { body: {}, ...callOpts(opts) });
  }
}

class Webhooks {
  /**
   * Verify a Standard Webhooks signature and return the parsed event. Throws WebhookVerificationError.
   * Pass the raw body exactly as received.
   */
  verify<T = Record<string, unknown>>(payload: string | Uint8Array | ArrayBuffer, headers: WebhookHeaders, secret: string, opts?: VerifyOptions): Promise<WebhookEvent<T>> {
    return verifyWebhook<T>(payload, headers, secret, opts);
  }
}
