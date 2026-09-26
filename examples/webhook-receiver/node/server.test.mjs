import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MobileValidate, TEST_NUMBERS, signWebhook } from "mobilevalidate";
import { createWebhookServer, handleEvent } from "./server.mjs";

const secret = "whsec_" + Buffer.from("example-webhook-secret-0123456789").toString("base64");
const received = [];
let server, url;

before(async () => {
  server = createWebhookServer({ secret, mv: new MobileValidate({ sandbox: true }), onEvent: async (e) => { received.push(e); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/webhooks/mobilevalidate`;
});
after(() => new Promise((r) => server.close(r)));

async function deliver(body, { id = "msg_1", ts = Math.floor(Date.now() / 1000), sig } = {}) {
  const signature = sig ?? (await signWebhook(secret, id, ts, body));
  return fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature } });
}
const event = JSON.stringify({ type: "lookup.completed", id: "evt_1", created_at: "2026-09-25T10:00:00Z", data: { object: "lookup", id: "lkp_1" } });

test("valid signature → 204 and the event is handled once, even when redelivered", async () => {
  assert.equal((await deliver(event, { id: "msg_a" })).status, 204);
  assert.equal((await deliver(event, { id: "msg_a" })).status, 204);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.filter((e) => e.id === "evt_1").length, 1);
});

test("tampered body, bad signature or an old timestamp → 400", async () => {
  const sig = await signWebhook(secret, "msg_b", Math.floor(Date.now() / 1000), event);
  assert.equal((await deliver(event.replace("lkp_1", "lkp_2"), { id: "msg_b", sig })).status, 400);
  assert.equal((await deliver(event, { id: "msg_c", sig: "v1,AAAA" })).status, 400);
  assert.equal((await deliver(event, { id: "msg_d", ts: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
});

test("job.completed handler pages through the job results", async () => {
  const mv = new MobileValidate({ sandbox: true });
  const { data: job, error } = await mv.jobs.create({ numbers: [TEST_NUMBERS.registered, TEST_NUMBERS.notRegistered, TEST_NUMBERS.unknown], checks: ["whatsapp"] });
  assert.equal(error, null);
  await mv.jobs.wait(job.id, { timeoutMs: 60_000 });
  const counts = await handleEvent({ type: "job.completed", data: { id: job.id } }, { mv });
  assert.deepEqual(counts, { registered: 1, not_registered: 1, unknown: 1, invalid: 0 });
});
