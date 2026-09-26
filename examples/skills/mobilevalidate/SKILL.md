---
name: mobilevalidate
description: Use when adding phone-number or e-mail validation to an app with the MobileValidate API or its SDKs (npm/PyPI `mobilevalidate`) — OTP or sign-up checks, choosing WhatsApp vs SMS, cleaning contact lists, receiving MobileValidate webhooks, or writing tests with its sandbox key and test values.
---

# MobileValidate integration

MobileValidate answers, before you send, whether a number is valid and where it is reachable (WhatsApp, Telegram,
Viber and more; carrier and line type) and whether an e-mail mailbox exists. Answers are `true | false | null`;
`null` = unknown, never billed. Full reference: `AGENTS.md` in this repository.

## Workflow

1. **Key.** Read `MOBILEVALIDATE_API_KEY` on the server. With no key, use the public sandbox key
   (`new MobileValidate({ sandbox: true })` / `MobileValidate(sandbox=True)`); it only answers the test values.
2. **One lookup, several checks.**
   ```js
   import { MobileValidate } from "mobilevalidate";
   const mv = new MobileValidate();
   const { data, error, requestId } = await mv.lookup(phone, { checks: ["whatsapp", "carrier"] });
   ```
   ```python
   from mobilevalidate import MobileValidate, MobileValidateError
   lookup = MobileValidate().lookup(phone, checks=["whatsapp", "carrier"])  # raises MobileValidateError
   ```
3. **Branch on the row** (see the decision tables below). Check `number_status` / `email_status` first.
4. **Handle errors** with `error.code` and show `error.suggestion`; fail open on `retryable` errors in user flows.
5. **Test** with the test values (never real numbers) — the recipes' tests show how, including a mock API.

## Decision tables

OTP / sign-up (recipe `otp-signup-guard`):

| Row | Action |
|---|---|
| `number_status !== "valid"` | ask the user to fix it; show `row.suggestion` |
| `checks["whatsapp.registered"].registered === true` | send the code on WhatsApp |
| `false` | SMS |
| `null` | SMS, but record "unknown", not "no" |
| carrier `line_type` in voip / premium_rate / toll_free / shared_cost | add friction (CAPTCHA), don't block |
| error, `retryable` | fail open (SMS) |

E-mail at sign-up (recipe `email-signup-check`): invalid → fix (show suggestion); `false` → ask to confirm the
spelling; `true` or `null` → allow.

Channel choice (recipe `choose-channel`): first `true` in your preference order; else SMS; landline → voice.

## Test values

Numbers: `+447700900001` registered · `…002` not registered · `…003` unknown · `…004` pending then registered ·
`…005` unsupported country · `…006` business · `…429` rate_limited error · `…402` insufficient_balance error.
E-mails `@test.mobilevalidate.com`: `registered`, `not-registered`, `unknown`, `pending`, `unsupported`,
`rate-limited`, `no-balance`. Exported as `TEST_NUMBERS` / `TEST_EMAILS` by both SDKs.

## Bulk and webhooks

- More than 100 values or bulk-only services → `jobs.create` → `jobs.wait` → iterate `jobs.results` (auto-pages).
- Webhooks: verify the raw body with `verifyWebhook` / `verify_webhook` before parsing; 2xx fast; dedupe by
  `webhook-id`. The sandbox key has no webhooks.
- CLI for quick checks: `npx mobilevalidate check +447700900001 --sandbox`,
  `npx mobilevalidate webhooks verify --secret … --file body.json --headers headers.txt`.

## Rules

- Never log full numbers or addresses (mask: `+44••••••••01`); log `requestId`.
- Never put a live key in client-side code or `NEXT_PUBLIC_…` variables.
- Never coerce `null` to `false`. Never add your own retry loop (the SDK retries retryable errors twice).
- Don't request `spam` unless the account has it (limited access); `carrier` is beta.
- Sandbox key: test values only, jobs ≤ 10 rows. Personal test keys: <https://mobilevalidate.com/get-test-key>.
- Deliverability and fraud prevention only — no unsolicited bulk messaging or user discovery features.
- The npm/PyPI packages are coming soon; check <https://mobilevalidate.com/docs/sdk> for status.
