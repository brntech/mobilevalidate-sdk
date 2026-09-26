import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_NUMBERS } from "mobilevalidate";
import { chooseChannel, chooseChannels } from "./choose-channel.mjs";

const c = (registered) => ({ status: registered === null ? "unknown" : "completed", registered, attributes: null });
const row = (checks) => ({ input: "+447700900001", e164: "+447700900001", number_status: "valid", checks });

test("first registered channel in preference order wins", () => {
  assert.equal(chooseChannel(row({ "whatsapp.registered": c(false), "telegram.registered": c(true), "viber.registered": c(true) })).channel, "telegram");
});

test("nothing registered → SMS; unknowns are reported, not treated as no", () => {
  const r = chooseChannel(row({ "whatsapp.registered": c(null), "telegram.registered": c(false), "viber.registered": c(false) }));
  assert.deepEqual([r.channel, r.reason, r.unknown], ["sms", "fallback_some_unknown", ["whatsapp"]]);
});

test("landline → voice", () => {
  const r = chooseChannel(row({ "whatsapp.registered": c(false), "network.carrier": { status: "completed", registered: true, attributes: { line_type: "fixed_line" } } }));
  assert.equal(r.channel, "voice");
});

test("end to end: test numbers through the SDK", async () => {
  const res = await chooseChannels([TEST_NUMBERS.registered, TEST_NUMBERS.notRegistered, TEST_NUMBERS.unknown], { withCarrier: true });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.choices.map((x) => x.channel), ["whatsapp", "sms", "sms"]);
  assert.deepEqual(res.choices[2].unknown, ["whatsapp", "telegram", "viber"]);
  assert.ok(res.requestId);
});
