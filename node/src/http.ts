import { createError, errorFromResponse } from "./errors.ts";
import type { Result } from "./types.ts";
import { VERSION } from "./version.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike;
  /** Injected for tests. */
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  idempotencyKey?: string;
  /** Extra time allowed for server-side long-polling (added to the per-request timeout). */
  extraTimeoutMs?: number;
  signal?: AbortSignal;
  /** Per-call override of the client's per-request timeout. */
  timeoutMs?: number;
  /** Per-call override of the client's retry count. */
  maxRetries?: number;
  /**
   * Return a successful response unread as `data` (a `Response`) instead of parsing JSON — for streamed files.
   * Errors are still parsed as JSON error bodies. The timeout covers the response headers only.
   */
  stream?: boolean;
  /** Accept header (default application/json). */
  accept?: string;
}

export interface RawResponse<T> {
  result: Result<T>;
  status: number | null;
  headers: Headers | null;
}

const MAX_BACKOFF_MS = 8_000;
/** Server hints beyond this are not worth blocking a caller for (e.g. daily caps). */
const MAX_RETRY_AFTER_MS = 60_000;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** UUID v4 (Web Crypto when available — Node ≥ 19, Bun, Deno, edge — else a Math.random fallback for Node 18). */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Exponential backoff with full jitter; Retry-After wins when present. */
export function backoffMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  if (retryAfterMs !== null) return retryAfterMs;
  return Math.floor(random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
}

export class HttpClient {
  private readonly cfg: HttpConfig;
  constructor(cfg: HttpConfig) {
    this.cfg = cfg;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<RawResponse<T>> {
    if (!this.cfg.apiKey) {
      const error = createError({
        code: "missing_api_key",
        message: "No API key. Set MOBILEVALIDATE_API_KEY, pass { apiKey }, or use { sandbox: true } to try the public sandbox key.",
      });
      return { result: { data: null, error, requestId: null }, status: null, headers: null };
    }
    // One key per logical call, reused across retries so the server can deduplicate.
    const idempotencyKey = method === "POST" ? opts.idempotencyKey ?? newIdempotencyKey() : undefined;
    const url = buildUrl(this.cfg.baseUrl, path, opts.query);
    let attempt = 0;
    for (;;) {
      const res = await this.once<T>(method, url, opts, idempotencyKey);
      const err = res.result.error;
      const maxRetries = opts.maxRetries ?? this.cfg.maxRetries;
      if (!err || !err.retryable || attempt >= maxRetries || opts.signal?.aborted) return res;
      if (err.retryAfterMs !== null && err.retryAfterMs > MAX_RETRY_AFTER_MS) return res;
      await this.cfg.sleep(backoffMs(attempt, err.retryAfterMs, this.cfg.random));
      attempt++;
    }
  }

  private async once<T>(method: string, url: string, opts: RequestOptions, idempotencyKey?: string): Promise<RawResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: opts.accept ?? "application/json",
      "User-Agent": `mobilevalidate-sdk/${VERSION}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const controller = new AbortController();
    const timeoutMs = (opts.timeoutMs ?? this.cfg.timeoutMs) + (opts.extraTimeoutMs ?? 0);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let streaming = false;
    try {
      const response = await this.cfg.fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (opts.stream && response.ok) {
        // The caller reads the body; keep the abort link so their signal can still cancel the stream.
        streaming = true;
        const rid = response.headers.get("x-request-id");
        return { result: { data: response as T, error: null, requestId: rid }, status: response.status, headers: response.headers };
      }
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      const headerRid = response.headers.get("x-request-id");
      if (!response.ok) {
        const error = errorFromResponse(response.status, body, response.headers);
        return { result: { data: null, error, requestId: error.requestId }, status: response.status, headers: response.headers };
      }
      if (text && body === null) {
        const error = createError({
          code: "invalid_response", message: "Response was not valid JSON", status: response.status, requestId: headerRid,
        });
        return { result: { data: null, error, requestId: headerRid }, status: response.status, headers: response.headers };
      }
      const bodyRid = body && typeof body === "object" && typeof (body as { request_id?: unknown }).request_id === "string"
        ? (body as { request_id: string }).request_id : null;
      return { result: { data: body as T, error: null, requestId: headerRid ?? bodyRid }, status: response.status, headers: response.headers };
    } catch (e) {
      const aborted = opts.signal?.aborted && !timedOut;
      const error = createError(
        timedOut
          ? { code: "timeout", message: `Request timed out after ${timeoutMs} ms` }
          : aborted
            ? { code: "connection_error", message: "Request aborted by caller", retryable: false }
            : { code: "connection_error", message: `Network error: ${(e as Error)?.message ?? "unknown"}` },
      );
      return { result: { data: null, error, requestId: null }, status: null, headers: null };
    } finally {
      clearTimeout(timer);
      if (!streaming) opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
