import { WebhookVerificationError } from "./errors.ts";
import type { WebhookEvent } from "./types.ts";

/**
 * Standard Webhooks verification using Web Crypto only (runs on Node, Bun, Deno and edge runtimes).
 * Signed content: `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256, base64, header `v1,<sig>`
 * (several space-separated signatures are allowed during secret rotation).
 */
export type WebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Allowed clock skew in seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" in unix seconds (tests). */
  now?: number;
}

const DEFAULT_TOLERANCE_S = 5 * 60;

function header(headers: WebhookHeaders, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * `whsec_<base64>` (Standard Webhooks; the form the API issues) → the decoded bytes. A secret without the prefix is
 * used as raw UTF-8 bytes, exactly like the API's signer.
 */
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (secret.startsWith("whsec_")) {
    try {
      return base64ToBytes(secret.slice(6));
    } catch {
      throw new WebhookVerificationError("Webhook secret is not valid whsec_<base64>");
    }
  }
  return new TextEncoder().encode(secret) as Uint8Array<ArrayBuffer>;
}

type Subtle = typeof globalThis.crypto.subtle;
let subtleCache: Subtle | null = null;
/** Web Crypto: global on Node ≥ 19, Bun, Deno and edge runtimes; on Node 18 it comes from node:crypto. */
async function subtle(): Promise<Subtle> {
  if (subtleCache) return subtleCache;
  const g = (globalThis as { crypto?: { subtle?: Subtle } }).crypto;
  if (g?.subtle) return (subtleCache = g.subtle);
  const mod = "node:crypto";
  const nodeCrypto = (await import(/* webpackIgnore: true */ /* @vite-ignore */ mod)) as { webcrypto: { subtle: Subtle } };
  return (subtleCache = nodeCrypto.webcrypto.subtle);
}

/** Constant-time comparison of two strings (length leak only). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute a `v1,<base64>` signature (useful to test your receiver locally). */
export async function sign(secret: string, id: string, timestamp: number | string, body: string): Promise<string> {
  const s = await subtle();
  const key = await s.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await s.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

/**
 * Verify a webhook and return the parsed event. Throws WebhookVerificationError on any failure.
 * `payload` must be the raw request body exactly as received (string or bytes), not re-serialized JSON.
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  payload: string | Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyOptions = {},
): Promise<WebhookEvent<T>> {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sigHeader = header(headers, "webhook-signature");
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header");
  if (!secret) throw new WebhookVerificationError("Missing webhook secret");

  const timestamp = Number(ts);
  if (!/^\d+$/.test(ts) || !Number.isSafeInteger(timestamp)) throw new WebhookVerificationError("Invalid webhook-timestamp");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_S;
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError("Webhook timestamp outside the tolerance window");

  const body = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  const expected = (await sign(secret, id, ts, body)).slice(3);
  const valid = sigHeader
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .some((s) => timingSafeEqual(s.slice(3), expected));
  if (!valid) throw new WebhookVerificationError("No matching signature");

  try {
    return JSON.parse(body) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError("Webhook body is not valid JSON");
  }
}
