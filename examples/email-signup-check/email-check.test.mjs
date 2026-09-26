import assert from "node:assert/strict";
import { test } from "node:test";
import { MobileValidate, TEST_EMAILS } from "mobilevalidate";
import { checkSignupEmail, decideEmail } from "./email-check.mjs";

// A personal test key answers any address (fake but stable); the sandbox key only the magic ones.
const LIVE = process.env.LIVE === "1";
const personal = process.env.MOBILEVALIDATE_TEST_KEY ?? (LIVE ? null : "mv_test_ExampleOnlyKeyForTheMockApi000000000");

test("decision table", () => {
  const row = (registered) => ({ kind: "email", email_status: "valid", checks: { "email.valid": { status: "completed", registered } } });
  assert.equal(decideEmail(row(true)).decision, "allow");
  assert.equal(decideEmail(row(false)).decision, "confirm");
  assert.equal(decideEmail(row(null)).decision, "allow");
  assert.deepEqual(decideEmail({ kind: "email", email_status: "invalid_email", suggestion: "Did you mean @gmail.com?" }),
    { decision: "fix", message: "Did you mean @gmail.com?" });
});

test("test addresses through the SDK (sandbox key)", async () => {
  assert.equal((await checkSignupEmail(TEST_EMAILS.registered)).decision, "allow");
  assert.equal((await checkSignupEmail(TEST_EMAILS.notRegistered)).decision, "confirm");
  assert.equal((await checkSignupEmail(TEST_EMAILS.unknown)).decision, "allow");
  assert.equal((await checkSignupEmail(TEST_EMAILS.pending)).decision, "allow");
});

test("malformed address → fix with the API suggestion (personal test key)", { skip: !personal && "needs MOBILEVALIDATE_TEST_KEY in LIVE mode" }, async () => {
  const mv = new MobileValidate({ apiKey: personal });
  const r = await checkSignupEmail("registered@@test.mobilevalidate.com", { mv }); // two @ signs
  assert.equal(r.decision, "fix");
  assert.ok(r.message);
});
