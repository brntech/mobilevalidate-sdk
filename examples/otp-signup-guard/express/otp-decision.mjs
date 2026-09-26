// Pure decision logic for the OTP / sign-up guard: no I/O, easy to unit-test.
// Input: one result row from mv.lookup(..., { checks: ["whatsapp", "carrier"] }). Output: what to do next.

/** Line types that deserve extra verification before you send a code (never a hard block on its own). */
const RISKY_LINE_TYPES = new Set(["voip", "premium_rate", "toll_free", "shared_cost"]);

/**
 * @param {import("mobilevalidate").ResultItem} row
 * @returns {{ action: "fix_number" | "send_whatsapp" | "send_sms", reason: string, suggestion?: string, extraVerification: boolean }}
 */
export function decideOtpChannel(row) {
  // 1. Invalid or unusable input: ask the user to fix it, and show the API's hint (e.g. missing country code).
  if (row.number_status !== "valid") {
    return {
      action: "fix_number",
      reason: row.number_status ?? "invalid_number",
      suggestion: row.suggestion ?? "Please enter your mobile number in international format, e.g. +44 7700 900001.",
      extraVerification: false,
    };
  }

  // 2. Optional carrier check (beta): VoIP and premium-rate numbers get extra friction (e.g. a CAPTCHA).
  //    Unknown carrier data (null attributes) is not a risk signal.
  const carrier = row.checks?.["network.carrier"];
  const lineType = carrier?.status === "completed" ? carrier.attributes?.line_type : undefined;
  const extraVerification = typeof lineType === "string" && RISKY_LINE_TYPES.has(lineType);

  // 3. Channel: WhatsApp only when it is known to be registered. `false` AND `null` (unknown) both fall back to SMS,
  //    but for different reasons — never treat unknown as "not registered" in your own data.
  const wa = row.checks?.["whatsapp.registered"];
  if (wa?.registered === true) return { action: "send_whatsapp", reason: "whatsapp_registered", extraVerification };
  if (wa?.registered === false) return { action: "send_sms", reason: "whatsapp_not_registered", extraVerification };
  return { action: "send_sms", reason: `whatsapp_unknown${wa?.status ? `:${wa.status}` : ""}`, extraVerification };
}

/**
 * What to do when the check itself fails. Fail open for temporary problems (never block sign-ups because a check
 * was unavailable); surface everything else so it gets fixed.
 * @param {import("mobilevalidate").MobileValidateError} error
 */
export function decideOnError(error) {
  if (error.retryable || error.code === "connection_error" || error.code === "timeout") {
    return { action: "send_sms", reason: `check_unavailable:${error.code}`, extraVerification: false };
  }
  return { action: "error", reason: error.code, suggestion: error.suggestion ?? undefined, extraVerification: false };
}

/** Mask a number for logs: "+447700900001" → "+44•••••••01". Never log full numbers. */
export function maskNumber(n) {
  const s = String(n ?? "");
  if (s.length < 6) return "•••";
  return s.slice(0, 3) + "•".repeat(Math.max(3, s.length - 5)) + s.slice(-2);
}
