import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MobileValidate, WebhookVerificationError, signWebhook, verifyWebhook } from "../src/index.ts";

const secret = "whsec_" + Buffer.from("super-secret-test-key-0123456789").toString("base64");
const body = JSON.stringify({ type: "job.completed", id: "evt_1", created_at: "2026-09-25T10:00:00Z", data: { job_id: "job_1" } });
const now = 1_790_000_000;

// Independent reference signature with node:crypto to cross-check the Web Crypto implementation.
function refSig(id: string, ts: number, payload: string) {
  const key = Buffer.from(secret.slice(6), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${payload}`).digest("base64");
}
const headers = (sig: string, ts = now) => ({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": sig });

describe("webhooks.verify (Standard Webhooks)", () => {
  it("accepts a valid signature and returns the event", async () => {
    const ev = await verifyWebhook(body, headers(refSig("msg_1", now, body)), secret, { now });
    expect(ev.type).toBe("job.completed");
    expect(await signWebhook(secret, "msg_1", now, body)).toBe(refSig("msg_1", now, body));
  });

  it("works through the client, with Headers objects, bytes and rotated signatures", async () => {
    const mv = new MobileValidate({ apiKey: "mv_test_x" });
    const h = new Headers(headers(`v1,AAAA ${refSig("msg_1", now, body)}`));
    const ev = await mv.webhooks.verify(new TextEncoder().encode(body), h, secret, { now });
    expect(ev.id).toBe("evt_1");
  });

  it("rejects a tampered body", async () => {
    await expect(verifyWebhook(body.replace("job_1", "job_2"), headers(refSig("msg_1", now, body)), secret, { now }))
      .rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects a wrong secret", async () => {
    const other = "whsec_" + Buffer.from("another-secret").toString("base64");
    await expect(verifyWebhook(body, headers(refSig("msg_1", now, body)), other, { now })).rejects.toThrow(/signature/);
  });

  it("rejects timestamps outside the 5-minute tolerance (both directions)", async () => {
    const old = now - 301;
    await expect(verifyWebhook(body, headers(refSig("msg_1", old, body), old), secret, { now })).rejects.toThrow(/tolerance/);
    const future = now + 301;
    await expect(verifyWebhook(body, headers(refSig("msg_1", future, body), future), secret, { now })).rejects.toThrow(/tolerance/);
    const edge = now - 300;
    await expect(verifyWebhook(body, headers(refSig("msg_1", edge, body), edge), secret, { now })).resolves.toBeTruthy();
  });

  it("rejects missing headers and non-v1 signatures", async () => {
    await expect(verifyWebhook(body, {}, secret, { now })).rejects.toThrow(/Missing/);
    const sig = refSig("msg_1", now, body).replace("v1,", "v2,");
    await expect(verifyWebhook(body, headers(sig), secret, { now })).rejects.toThrow(/signature/);
  });
});
