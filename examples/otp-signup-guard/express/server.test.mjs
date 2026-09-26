// End-to-end through the SDK. Needs MOBILEVALIDATE_BASE_URL (the mock API) or LIVE=1 (the real API, sandbox key).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MobileValidate, TEST_NUMBERS } from "mobilevalidate";
import { createApp } from "./server.mjs";

let server, base;
before(async () => {
  const app = createApp(new MobileValidate({ sandbox: true }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const post = async (body) => {
  const res = await fetch(`${base}/signup/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("registered number → WhatsApp", async () => {
  const r = await post({ phone: TEST_NUMBERS.registered });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, "send_whatsapp");
});

test("not registered → SMS; unknown → SMS", async () => {
  assert.equal((await post({ phone: TEST_NUMBERS.notRegistered })).body.reason, "whatsapp_not_registered");
  assert.match((await post({ phone: TEST_NUMBERS.unknown })).body.reason, /^whatsapp_unknown/);
});

test("pending number is waited for and ends on WhatsApp", async () => {
  assert.equal((await post({ phone: TEST_NUMBERS.pending })).body.action, "send_whatsapp");
});

test("non-test number with the sandbox key → error with a suggestion", async () => {
  const r = await post({ phone: "+447700900999" });
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, "sandbox_magic_only");
  assert.ok(r.body.suggestion);
});

// A personal test key answers any input (the sandbox key only the test values), so it can show invalid-number hints.
const LIVE = process.env.LIVE === "1";
const personal = process.env.MOBILEVALIDATE_TEST_KEY ?? (LIVE ? null : "mv_test_ExampleOnlyKeyForTheMockApi000000000");
test("number without country code → 422 fix_number with the API suggestion", { skip: !personal && "needs MOBILEVALIDATE_TEST_KEY in LIVE mode" }, async () => {
  const app = createApp(new MobileValidate({ apiKey: personal }));
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/signup/check`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "7700 900001" }),
    });
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.equal(body.action, "fix_number");
    assert.ok(body.suggestion);
  } finally {
    await new Promise((r) => s.close(r));
  }
});
