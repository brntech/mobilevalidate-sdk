import assert from "node:assert/strict";
import { test } from "node:test";
import { decideOnError, decideOtpChannel, maskNumber } from "./otp-decision.mjs";

const check = (registered, status = registered === null ? "unknown" : "completed", attributes = null) =>
  ({ status, registered, attributes });
const row = (checks, extra = {}) => ({ input: "+447700900001", e164: "+447700900001", number_status: "valid", checks, ...extra });

test("registered on WhatsApp → WhatsApp", () => {
  assert.equal(decideOtpChannel(row({ "whatsapp.registered": check(true) })).action, "send_whatsapp");
});

test("not registered and unknown → SMS, with different reasons", () => {
  const no = decideOtpChannel(row({ "whatsapp.registered": check(false) }));
  const unknown = decideOtpChannel(row({ "whatsapp.registered": check(null) }));
  assert.deepEqual([no.action, no.reason], ["send_sms", "whatsapp_not_registered"]);
  assert.deepEqual([unknown.action, unknown.reason], ["send_sms", "whatsapp_unknown:unknown"]);
});

test("invalid number → fix_number with the API suggestion", () => {
  const d = decideOtpChannel({ input: "7700900001", e164: null, number_status: "invalid_number", suggestion: "Add the country code." });
  assert.equal(d.action, "fix_number");
  assert.equal(d.suggestion, "Add the country code.");
});

test("VoIP line type → extra verification; unknown carrier is not a risk", () => {
  const voip = decideOtpChannel(row({ "whatsapp.registered": check(true), "network.carrier": check(true, "completed", { line_type: "voip" }) }));
  const mobile = decideOtpChannel(row({ "whatsapp.registered": check(true), "network.carrier": check(true, "completed", { line_type: "mobile" }) }));
  const unk = decideOtpChannel(row({ "whatsapp.registered": check(false), "network.carrier": check(null) }));
  assert.equal(voip.extraVerification, true);
  assert.equal(mobile.extraVerification, false);
  assert.equal(unk.extraVerification, false);
});

test("errors: fail open when temporary, surface otherwise", () => {
  assert.equal(decideOnError({ code: "rate_limited", retryable: true }).action, "send_sms");
  assert.equal(decideOnError({ code: "timeout", retryable: true }).action, "send_sms");
  const e = decideOnError({ code: "sandbox_magic_only", retryable: false, suggestion: "Use a test value." });
  assert.deepEqual([e.action, e.suggestion], ["error", "Use a test value."]);
});

test("maskNumber never shows the full number", () => {
  assert.equal(maskNumber("+447700900001"), "+44••••••••01");
  assert.ok(!maskNumber("+447700900001").includes("7700900"));
});
