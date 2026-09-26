import { MobileValidate, SANDBOX_PUBLIC_KEY } from "mobilevalidate";
import type { Sdk } from "./tools.ts";

/** Headers the API trusts only together with the shared secret (env MV_MCP_FORWARD_SECRET on both sides). */
export const FORWARDED_IP_HEADER = "x-mv-client-ip";
export const FORWARD_SECRET_HEADER = "x-mv-forward-secret";

export interface ForwardClient {
  /** The end client's IP address, as seen by this server. */
  clientIp: string;
  /** Shared secret proving to the API that this server set the header. */
  secret: string;
}

/**
 * SDK client for one agent key. Base URL from env MOBILEVALIDATE_BASE_URL (default https://api.mobilevalidate.com).
 * With `forward`, every API request names the end client, so the public sandbox key's per-IP limits apply per end
 * client instead of to this server's own IP.
 */
export function sdkFor(apiKey: string, forward?: ForwardClient): Sdk {
  const headers = forward ? { [FORWARDED_IP_HEADER]: forward.clientIp, [FORWARD_SECRET_HEADER]: forward.secret } : null;
  return new MobileValidate({
    apiKey,
    baseUrl: process.env.MOBILEVALIDATE_BASE_URL || undefined,
    maxRetries: 1,
    fetch: headers
      ? (input, init) => globalThis.fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } })
      : undefined,
  });
}

/** Forward the end client only for the shared public sandbox key (the only key limited per IP), and only with a secret. */
export function forwardFor(apiKey: string, clientIp: string | null, secret: string | null | undefined): ForwardClient | undefined {
  return apiKey === SANDBOX_PUBLIC_KEY && secret && clientIp ? { clientIp, secret } : undefined;
}
