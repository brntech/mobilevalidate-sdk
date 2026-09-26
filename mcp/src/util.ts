import { maskPhone } from "./normalize.ts";

/** Key policy for agent surfaces: agent or test keys only. Live keys are never accepted by the MCP server. */
export type KeyCheck = { ok: true; key: string } | { ok: false; message: string };

export function checkAgentKey(key: string | undefined | null): KeyCheck {
  const k = (key ?? "").trim();
  if (!k) return { ok: false, message: "Missing API key. Provide an mv_agent_… or mv_test_… key (env MOBILEVALIDATE_API_KEY for stdio, Authorization: Bearer for HTTP)." };
  if (k.startsWith("mv_live_")) {
    return { ok: false, message: "Live keys (mv_live_…) are not accepted by the MCP server. Create an agent key (mv_agent_…, scoped and spend-capped) in the dashboard, or use a test key (mv_test_…)." };
  }
  if (!/^mv_(agent|test)_[A-Za-z0-9]+$/.test(k)) return { ok: false, message: "Unrecognized API key format. Expected mv_agent_… or mv_test_…." };
  return { ok: true, key: k };
}

/** Decimal string → integer micro-units (no floats). Accepts up to 6 decimals; more are truncated. */
export function toMicro(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid amount: ${amount}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0"));
}

/** Integer micro-units → shortest decimal string ("1.2", "0.0036", "0"). */
export function fromMicro(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const PHONE_LIKE = /\+?\d[\d\s-]{6,}\d/g;
const EMAIL_LIKE = /([A-Za-z0-9._%+'-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** stderr logger (stdout belongs to the stdio transport). Phone-like digit runs and e-mail addresses are masked defensively. */
export function log(msg: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  if (process.env.MCP_LOG === "off") return;
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  const line = `[mobilevalidate-mcp] ${msg}${kv ? " " + kv : ""}`
    .replace(EMAIL_LIKE, (_m, local: string, domain: string) => `${local.slice(0, 2)}•••@${domain}`)
    .replace(PHONE_LIKE, (m) => maskPhone(m.replace(/[\s-]/g, "")));
  process.stderr.write(line + "\n");
}
