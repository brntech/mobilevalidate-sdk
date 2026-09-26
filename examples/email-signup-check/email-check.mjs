// E-mail check at sign-up: catch typos and dead mailboxes before you send the confirmation e-mail.
// Answers are yes / no / unknown only — never names or profiles.
import { MobileValidate } from "mobilevalidate";

/**
 * Pure: decide from one e-mail result row.
 * @param {import("mobilevalidate").ResultItem} row
 * @returns {{ decision: "allow" | "confirm" | "fix", message?: string }}
 */
export function decideEmail(row) {
  if (row.email_status !== "valid") {
    // invalid_email rows may carry a hint, e.g. "Did you mean @gmail.com?"
    return { decision: "fix", message: row.suggestion ?? "Please check your e-mail address." };
  }
  const c = row.checks?.["email.valid"];
  if (c?.registered === false) {
    // The mailbox does not seem to exist: ask the user to double-check, but let them continue if they insist.
    return { decision: "confirm", message: "We couldn't find this mailbox. Is the address spelled correctly?" };
  }
  // true → allow; null (unknown, never billed) → allow too: don't block a real user on an uncertain answer.
  return { decision: "allow" };
}

export async function checkSignupEmail(email, { mv } = {}) {
  const client = mv ?? (process.env.MOBILEVALIDATE_API_KEY ? new MobileValidate() : new MobileValidate({ sandbox: true }));
  const { data, error, requestId } = await client.lookup({ emails: [email], checks: ["email"], wait: 5, waitTimeoutMs: 8_000 });
  if (error) {
    // Fail open on temporary problems; log the code and request id (never the address itself).
    console.warn(JSON.stringify({ code: error.code, requestId, suggestion: error.suggestion }));
    return { decision: "allow", reason: error.code, requestId };
  }
  return { ...decideEmail(data.results[0]), requestId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2] ?? "registered@test.mobilevalidate.com";
  console.log(await checkSignupEmail(email));
}
