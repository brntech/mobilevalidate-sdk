// Choose the channel for a message: WhatsApp, Telegram or Viber when the number is known to be registered there,
// otherwise SMS — or a voice call for landlines, which can't receive SMS. One lookup, several checks.
import { MobileValidate } from "mobilevalidate";

/** Your preference order (e.g. cheapest first). SMS is always the fallback. */
export const DEFAULT_ORDER = [
  { channel: "whatsapp", service: "whatsapp.registered" },
  { channel: "telegram", service: "telegram.registered" },
  { channel: "viber", service: "viber.registered" },
];

/**
 * Pure: pick a channel from one result row.
 * @param {import("mobilevalidate").ResultItem} row
 * @returns {{ channel: string, reason: string, unknown: string[], suggestion?: string }}
 */
export function chooseChannel(row, order = DEFAULT_ORDER) {
  if (row.number_status !== "valid") {
    return { channel: "none", reason: row.number_status ?? "invalid_number", unknown: [], suggestion: row.suggestion };
  }
  const unknown = [];
  for (const { channel, service } of order) {
    const c = row.checks?.[service];
    if (c?.registered === true) return { channel, reason: `${channel}_registered`, unknown };
    // null = unknown: we can't rely on the channel, but it is not a "no" either. Remember it for your own retries.
    if (!c || c.registered === null) unknown.push(channel);
  }
  const lineType = row.checks?.["network.carrier"]?.attributes?.line_type;
  if (lineType === "fixed_line") return { channel: "voice", reason: "fixed_line", unknown };
  return { channel: "sms", reason: unknown.length ? "fallback_some_unknown" : "fallback_none_registered", unknown };
}

/** Check up to 100 numbers in one request and choose a channel for each. */
export async function chooseChannels(numbers, { mv, order = DEFAULT_ORDER, withCarrier = false } = {}) {
  const client = mv ?? (process.env.MOBILEVALIDATE_API_KEY ? new MobileValidate() : new MobileValidate({ sandbox: true }));
  const checks = [...order.map((o) => o.service), ...(withCarrier ? ["network.carrier"] : [])];
  const { data, error, requestId } = await client.lookup(numbers, { checks });
  if (error) return { error, requestId };
  return { requestId, choices: data.results.map((row) => ({ input: row.input, ...chooseChannel(row, order) })) };
}

const mask = (n) => (n.length < 6 ? "•••" : n.slice(0, 3) + "•".repeat(n.length - 5) + n.slice(-2));

if (import.meta.url === `file://${process.argv[1]}`) {
  const numbers = process.argv.slice(2);
  const res = await chooseChannels(numbers.length ? numbers : ["+447700900001", "+447700900002", "+447700900003"]);
  if (res.error) {
    console.error(`${res.error.code}: ${res.error.message}${res.error.suggestion ? `\n  Suggestion: ${res.error.suggestion}` : ""}`);
    process.exitCode = 1;
  } else {
    for (const c of res.choices) console.log(`${mask(c.input)} → ${c.channel} (${c.reason}${c.unknown.length ? `; unknown: ${c.unknown.join(",")}` : ""})`);
  }
}
