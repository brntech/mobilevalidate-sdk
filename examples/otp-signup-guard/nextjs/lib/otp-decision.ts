// Pure decision logic for the OTP / sign-up guard (no I/O). Same rules as the Express variant.
import type { MobileValidateError, ResultItem } from "mobilevalidate";

export type OtpDecision = {
  action: "fix_number" | "send_whatsapp" | "send_sms" | "error";
  reason: string;
  suggestion?: string;
  extraVerification: boolean;
};

/** Line types that deserve extra verification (e.g. a CAPTCHA) before you send a code. Never a hard block alone. */
const RISKY_LINE_TYPES = new Set(["voip", "premium_rate", "toll_free", "shared_cost"]);

export function decideOtpChannel(row: ResultItem): OtpDecision {
  if (row.number_status !== "valid") {
    return {
      action: "fix_number",
      reason: String(row.number_status ?? "invalid_number"),
      suggestion: row.suggestion ?? "Please enter your mobile number in international format, e.g. +44 7700 900001.",
      extraVerification: false,
    };
  }
  const carrier = row.checks?.["network.carrier"];
  const lineType = carrier?.status === "completed" ? carrier.attributes?.line_type : undefined;
  const extraVerification = typeof lineType === "string" && RISKY_LINE_TYPES.has(lineType);

  const wa = row.checks?.["whatsapp.registered"];
  if (wa?.registered === true) return { action: "send_whatsapp", reason: "whatsapp_registered", extraVerification };
  if (wa?.registered === false) return { action: "send_sms", reason: "whatsapp_not_registered", extraVerification };
  // null = unknown (never billed): fall back to SMS, but don't store it as "not registered".
  return { action: "send_sms", reason: `whatsapp_unknown${wa?.status ? `:${wa.status}` : ""}`, extraVerification };
}

/** Fail open for temporary problems (never block sign-ups because a check was unavailable); surface the rest. */
export function decideOnError(error: MobileValidateError): OtpDecision {
  if (error.retryable || error.code === "connection_error" || error.code === "timeout") {
    return { action: "send_sms", reason: `check_unavailable:${error.code}`, extraVerification: false };
  }
  return { action: "error", reason: String(error.code), suggestion: error.suggestion ?? undefined, extraVerification: false };
}

/** "+447700900001" → "+44••••••••01". Never log full numbers. */
export function maskNumber(n: string): string {
  if (n.length < 6) return "•••";
  return n.slice(0, 3) + "•".repeat(Math.max(3, n.length - 5)) + n.slice(-2);
}
