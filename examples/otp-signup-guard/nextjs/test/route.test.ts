// Calls the route handler directly with Web Request objects (no Next.js server needed). Node >= 22.18 runs .ts files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_NUMBERS } from "mobilevalidate";
import { POST } from "../app/api/otp/route.ts";
import { decideOtpChannel } from "../lib/otp-decision.ts";

const call = async (body: unknown) => {
  const res = await POST(new Request("http://localhost/api/otp", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { action: string; reason: string; suggestion?: string } };
};

test("registered → WhatsApp, not registered → SMS, unknown → SMS", async () => {
  assert.equal((await call({ phone: TEST_NUMBERS.registered })).body.action, "send_whatsapp");
  assert.equal((await call({ phone: TEST_NUMBERS.notRegistered })).body.reason, "whatsapp_not_registered");
  assert.match((await call({ phone: TEST_NUMBERS.unknown })).body.reason, /^whatsapp_unknown/);
});

test("missing phone → 400; sandbox refuses non-test numbers with a suggestion", async () => {
  assert.equal((await call({})).status, 400);
  const r = await call({ phone: "+447700900999" });
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, "sandbox_magic_only");
  assert.ok(r.body.suggestion);
});

test("decision: invalid number shows the suggestion", () => {
  const d = decideOtpChannel({ input: "07700", e164: null, country: null, number_status: "invalid_number", suggestion: "Add the country code." });
  assert.deepEqual([d.action, d.suggestion], ["fix_number", "Add the country code."]);
});
