# AGENTS.md — integrating MobileValidate

Instructions for coding agents (and humans) adding MobileValidate to an application.

## What it is

MobileValidate is an API that tells you, before you send, whether a phone number is valid and where it can be
reached: registration on WhatsApp, Telegram, Viber and other platforms, carrier and line type, and e-mail mailbox
checks. Use it for deliverability and fraud prevention (OTP routing, sign-up checks, list hygiene). Every answer is
`registered: true | false | null`; `null` means **unknown** and is never billed.

## Setup

| | Node (≥ 18, ESM + CJS, zero deps) | Python (≥ 3.9, httpx) |
|---|---|---|
| Install | `npm install mobilevalidate` | `pip install mobilevalidate-sdk` |
| Client | `new MobileValidate()` | `MobileValidate()` / `AsyncMobileValidate()` |
| Sandbox | `new MobileValidate({ sandbox: true })` | `MobileValidate(sandbox=True)` |
| Errors | returned: `const { data, error, requestId } = await …` | raised: `except MobileValidateError as e` |

- Key: environment variable **`MOBILEVALIDATE_API_KEY`** (server-side only). Base URL override: `MOBILEVALIDATE_BASE_URL`.
- The packages are not published yet (coming soon); check <https://mobilevalidate.com/docs/sdk> before telling a user
  to install them.
- Without a key, use the public sandbox key (`sandbox: true`). It only answers the test values below.

## Test values (use these in tests, examples and docs — never real numbers)

| Number | Answer | E-mail | Answer |
|---|---|---|---|
| `+447700900001` | registered | `registered@test.mobilevalidate.com` | registered |
| `+447700900002` | not registered | `not-registered@test.mobilevalidate.com` | not registered |
| `+447700900003` | unknown (`registered: null`) | `unknown@test.mobilevalidate.com` | unknown |
| `+447700900004` | pending ~5 s, then registered | `pending@test.mobilevalidate.com` | pending, then registered |
| `+447700900005` | `unsupported_country` | `unsupported@test.mobilevalidate.com` | unknown |
| `+447700900006` | registered, business account | | |
| `+447700900429` | request fails: `rate_limited` | `rate-limited@test.mobilevalidate.com` | `rate_limited` |
| `+447700900402` | request fails: `insufficient_balance` | `no-balance@test.mobilevalidate.com` | `insufficient_balance` |

The SDKs export them: `TEST_NUMBERS.registered` (Node), `TEST_NUMBERS["registered"]` (Python), and `TEST_EMAILS`.

## The result model

```js
const { data, error } = await mv.lookup(["+447700900001"], { checks: ["whatsapp", "carrier"] });
const row = data.results[0];
row.number_status;                              // "valid" | "invalid_number" | "duplicate" | "suppressed"
row.suggestion;                                 // hint for invalid input, e.g. a missing country code
row.checks["whatsapp.registered"].registered;   // true | false | null
row.checks["network.carrier"].attributes;       // { line_type, carrier, country } or null (beta)
```

- **Never coerce `null` to `false`.** Unknown is its own branch (usually: fall back, retry later, don't store "no").
- Check `number_status` / `email_status` before reading `checks`; invalid rows have no `checks`.
- Aliases in `checks`: `whatsapp`, `telegram`, `viber`, `carrier`, `email`, … (`mv.services()` lists what the key can use).
- Numbers go in `numbers` (E.164, or national format with `defaultCountry`), addresses in `emails`; ≤ 100 per lookup.
- `lookup` waits for slow answers automatically (long-polling). `wait: 0` returns at once with `status: "pending"`.
- Money is a decimal string (`{ amount: "0.0012", currency: "USD" }`), never a float.

## Errors

Every error has `code`, `message`, `status`, `retryable`, `param`, `suggestion`, `docUrl`/`doc_url`, `requestId`/`request_id`,
and a class per code (`SandboxMagicOnlyError`, `RateLimitedError`, `ServiceDisabledError`, `InsufficientBalanceError`, …).

- Show or log `suggestion` — it says how to fix the request. Log `requestId` for support.
- Retries are automatic (2 retries, jittered backoff, `Retry-After` honoured) for retryable errors only. Don't add
  your own retry loop around the SDK.
- Idempotency keys are added to every POST automatically, so SDK retries never double-charge.
- For user-facing flows, fail open on temporary errors (`retryable`, timeouts): don't block a sign-up because a check
  was unavailable.

## Bulk jobs

Use jobs for more than 100 values or for bulk-only services (a `service_disabled` error from `lookup` says so):
`jobs.create({ numbers, checks })` → `jobs.wait(id)` → `for await (const row of mv.jobs.results(id))` (auto-pagination).

## Webhooks

Verify with `verifyWebhook(rawBody, headers, secret)` (Node) / `verify_webhook(raw, headers, secret)` (Python) on the
**raw** request body, before parsing JSON. Answer 2xx fast, dedupe by the `webhook-id` header, and fetch results with
the API key (events never contain numbers). Secrets look like `whsec_…` and are shown once.

## Pitfalls

- **Never log full phone numbers or e-mail addresses.** Mask them (`+44••••••••01`); log the `requestId` instead.
- **Never ship a live key to a browser or mobile app** (`NEXT_PUBLIC_…`, client bundles). Call the API from your server.
- The **sandbox key** only accepts the test values (`403 sandbox_magic_only` otherwise), allows jobs of ≤ 10 rows and
  has no webhooks. For more, get a personal test key at <https://mobilevalidate.com/get-test-key>.
- `spam` (`number.spam`) is limited-access and US/CA/DE only; including it fails the whole request for most keys.
- `carrier` is in beta; don't make it a hard gate.
- Some services are bulk only (e.g. `signal`); `lookup` refuses them with `service_disabled`.
- Runs of consecutive numbers or digit-variant e-mails are refused (`suspected_enumeration`).
- Use MobileValidate for deliverability and fraud prevention. Don't build unsolicited bulk messaging, scraping or
  "find all users of app X" features with it.

## Links

Docs <https://mobilevalidate.com/docs> · Test values <https://mobilevalidate.com/docs/test-values> ·
Errors <https://mobilevalidate.com/docs/errors> · Webhooks <https://mobilevalidate.com/docs/webhooks> ·
SDK <https://mobilevalidate.com/docs/sdk> · MCP for agents <https://mobilevalidate.com/docs/mcp> ·
Recipes in this repository.
