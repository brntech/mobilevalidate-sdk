# mobilevalidate

Official TypeScript/JavaScript client and CLI for the [MobileValidate](https://mobilevalidate.com) API: *know before
you send*. Check whether a phone number is registered on WhatsApp, Telegram, Viber and [many other services](#services),
look up carrier and line type, get a report-based spam reputation, and verify e-mail addresses. You can run several
checks in one request.

Every answer is `registered: true | false | null`. Data services such as the carrier lookup or spam reputation return
a whitelisted set of `attributes` instead. `null` means **unknown**, and unknown answers are never billed. Each answer
also carries `confidence`, `checked_at`, `cached` and `billed`.

- **Zero runtime dependencies.** Uses `fetch` and Web Crypto. Runs on Node.js ≥ 18, Bun, Deno and edge runtimes.
  Ships ESM and CommonJS builds with TypeScript types. The CLI needs Node.js.
- **Typed errors.** One error class per API error code (`RateLimitedError`, `SandboxMagicOnlyError`, …), each with
  `code`, `status`, `retryable`, `param`, `docUrl`, `requestId` and a plain-English `suggestion` when the API has one.
- **No exceptions by default.** Methods return `{ data, error, requestId }`. Pass `throwOnError: true` if you prefer
  exceptions.
- **Safe retries.** Retryable errors and 429s are retried twice with jittered exponential backoff, and `Retry-After` is
  honoured. Every POST gets an automatic `Idempotency-Key`, so a retry is never charged twice.
- **Timeouts** per client and per call. **Auto-pagination** of job results. **Waits for slow answers**: `lookup()`
  long-polls until the lookup completes or the wait budget runs out.
- **Webhook verification** (Standard Webhooks) for Node, Bun, Deno and edge runtimes.

Docs: <https://mobilevalidate.com/docs/sdk> · Test values: <https://mobilevalidate.com/docs/test-values> ·
Recipes: <https://mobilevalidate.com/docs/recipes> · AI agents: [MCP](#use-with-ai-agents-mcp)

## Try it in 30 seconds (no signup)

The public **sandbox key** is built in. It answers only the documented [test values](#test-values), is never billed
and never reaches a real network.

```bash
npx mobilevalidate check +447700900001 +447700900002 registered@test.mobilevalidate.com --sandbox
```

```bash
npm install mobilevalidate
```

```ts
// check.mjs (ESM; Node 18+). CommonJS works too: const { MobileValidate } = require("mobilevalidate");
import { MobileValidate, TEST_NUMBERS } from "mobilevalidate";

const mv = new MobileValidate({ sandbox: true }); // later: new MobileValidate() reads MOBILEVALIDATE_API_KEY

const { data, error, requestId } = await mv.lookup(TEST_NUMBERS.registered, { checks: ["whatsapp"] });
if (error) {
  console.error(error.code, error.message, error.suggestion, requestId);
} else {
  const r = data.results[0].checks["whatsapp.registered"];
  if (r.registered === true) console.log("send on WhatsApp");
  else if (r.registered === false) console.log("fall back to SMS");
  else console.log("unknown:", r.status, r.reason, "(not billed)");
}
```

`+447700900001` answers *registered*, `+447700900002` *not registered* and `+447700900003` *unknown*. With the sandbox
key any other number returns `403 sandbox_magic_only`, with a suggestion.

## Keys

| Key | What it answers | Get it |
|---|---|---|
| Sandbox key (`sandbox: true`) | The [test values](#test-values) only. Rate limited per IP (30/min, 1,000/day). Bulk jobs of at most 10 rows. No webhooks. | Built in. Public by design. |
| Personal test key (`mv_test_…`) | Test values as documented. Any other number or address gets a fake but stable answer (the same input always gives the same result). Bulk jobs and webhooks work. Never billed, never reaches a network. | <https://mobilevalidate.com/get-test-key> |
| Live key (`mv_live_…`) | Real checks, billed per conclusive answer. | Approved access request |
| Agent key (`mv_agent_…`) | Like live, scoped and with a daily spend cap. Meant for AI agents and automations. | Approved access request |

Put the key in `MOBILEVALIDATE_API_KEY`. `new MobileValidate()` reads it, and so does the CLI. Moving from test to
live changes nothing else in your code.

## Checks

### Several services in one request

```ts
const { data } = await mv.lookup(["+447700900001", "+447700900002"], {
  checks: ["whatsapp", "telegram", "viber", "carrier"],
});
for (const item of data?.results ?? []) {
  console.log(item.e164, item.checks?.["telegram.registered"]?.registered, item.checks?.["network.carrier"]?.attributes);
}
console.log(data?.summary.by_service);            // counts per service
const { data: catalog } = await mv.services();    // what your key can use, with prices
```

`mv.whatsapp.check(numbers)` is a shortcut for `lookup` with `checks: ["whatsapp"]`. Its results also carry the v1
top-level `whatsapp` fields.

### E-mail addresses

Phone checks run on `numbers` and e-mail checks on `emails`. You can send both in one request (at most 100 in total).
E-mail answers are yes / no / unknown only, never names, photos or profiles.

```ts
const { data } = await mv.lookup({
  numbers: ["+447700900001"],
  emails: ["registered@test.mobilevalidate.com"],
  checks: ["whatsapp", "email"],
});
for (const item of data?.results ?? []) {          // rows: numbers first, then e-mails
  if (item.kind === "email") console.log(item.email, item.email_status, item.checks?.["email.valid"]?.registered);
  else console.log(item.e164, item.number_status, item.checks?.["whatsapp.registered"]?.registered);
  if (item.suggestion) console.log("hint:", item.suggestion); // e.g. a missing country code or a mistyped domain
}
```

## Services

Pass codes or aliases in `checks`. The `ServiceCode` / `CheckInput` types autocomplete them. They are open unions, so
newer codes from the API are accepted too. `lookup()` refuses "bulk only" services with `service_disabled`; use them in
`jobs.create()`. `mv.services()` returns the live list for your key, with prices. `SERVICE_CATALOG` is the list this
SDK version was built with. Platform names are used descriptively only. MobileValidate is not affiliated with,
endorsed or sponsored by any of these platforms.

<!-- services:start (generated by scripts/gen-services.ts) -->
| Code | Alias | Platform | Input | Result | Real time | Attributes | Countries |
|---|---|---|---|---|---|---|---|
| `whatsapp.registered` | `whatsapp` | WhatsApp | phone | registered | yes | — | all |
| `whatsapp.business` | — | WhatsApp | phone | registered | yes | `business` | all |
| `telegram.registered` | `telegram` | Telegram | phone | registered | yes | — | all |
| `viber.registered` | `viber` | Viber | phone | registered | yes | — | all |
| `signal.registered` | `signal` | Signal | phone | registered | bulk only | — | all |
| `imessage.registered` | `imessage` | iMessage | phone | registered | bulk only | — | all |
| `rcs.registered` | `rcs` | RCS | phone | registered | bulk only | `device_os` | all |
| `line.registered` | `line` | LINE | phone | registered | bulk only | — | all |
| `zalo.registered` | `zalo` | Zalo | phone | registered | yes | — | all |
| `botim.registered` | `botim` | Botim | phone | registered | bulk only | — | all |
| `max.registered` | `max` | MAX | phone | registered | bulk only | — | all |
| `messenger.registered` | `messenger` | Facebook Messenger | phone | registered | bulk only | — | all |
| `facebook.registered` | `facebook` | Facebook | phone | registered | yes | — | all |
| `instagram.registered` | `instagram` | Instagram | phone | registered | yes | — | all |
| `threads.registered` | `threads` | Threads | phone | registered | yes | — | all |
| `x.registered` | `x`, `twitter` | X (Twitter) | phone | registered | yes | — | all |
| `tiktok.registered` | `tiktok` | TikTok | phone | registered | bulk only | — | all |
| `snapchat.registered` | `snapchat` | Snapchat | phone | registered | bulk only | — | all |
| `linkedin.registered` | `linkedin` | LinkedIn | phone | registered | bulk only | — | US, IN |
| `apple.registered` | `apple` | Apple | phone | registered | yes | — | all |
| `amazon.registered` | `amazon` | Amazon | phone | registered | yes | — | all |
| `microsoft.registered` | `microsoft` | Microsoft | phone | registered | yes | — | all |
| `netflix.registered` | `netflix` | Netflix | phone | registered | yes | — | all |
| `network.carrier` | `carrier` | Mobile network | phone | data (beta) | yes | `line_type`, `carrier`, `original_carrier`, `country` | all |
| `network.carrier_us` | — | Mobile network | phone | data | bulk only | `line_type`, `carrier` | US, CA |
| `number.spam` | `spam` | Spam reputation | phone | data | yes | `risk_level`, `risk_score`, `reason_regulator`, `reason_government`, `reason_community`, `reason_unassigned`, `voip_range`, `top_category`, `first_seen`, `last_seen`, `sources`, `premium_rate`, `personal_number` | all |
| `number.hlr` | `hlr` | Mobile network | phone | data | yes | `status`, `ported`, `roaming`, `network`, `mcc_mnc`, `country` | all |
| `number.mnp` | `mnp`, `porting` | Mobile network | phone | data | yes | `porting`, `mcc_mnc`, `country` | all |
| `email.valid` | `email` | E-mail | e-mail | registered | yes | — | all |
| `gmail.email` | `gmail` | Gmail | e-mail | registered | bulk only | — | all |
| `outlook.email` | `outlook` | Outlook | e-mail | registered | bulk only | — | all |
| `yahoo.email` | `yahoo` | Yahoo | e-mail | registered | bulk only | — | all |
| `yandex.email` | `yandex` | Yandex | e-mail | registered | bulk only | — | all |
| `mailru.email` | `mailru` | Mail.ru | e-mail | registered | bulk only | — | all |
| `apple.email` | `apple.email` | Apple | e-mail | registered | yes | — | all |
| `amazon.email` | — | Amazon | e-mail | registered | yes | — | all |
| `facebook.email` | — | Facebook | e-mail | registered | yes | — | all |
| `instagram.email` | — | Instagram | e-mail | registered | yes | — | all |
| `netflix.email` | — | Netflix | e-mail | registered | yes | — | all |
| `spotify.email` | — | Spotify | e-mail | registered | yes | — | all |
| `linkedin.email` | — | LinkedIn | e-mail | registered | bulk only | — | all |
| `x.email` | — | X (Twitter) | e-mail | registered | bulk only | — | all |
<!-- services:end -->


In test mode the test numbers below apply to every phone service. `…006` is a business account only for
`whatsapp.business`. The carrier lookup answers `{ line_type: "mobile", carrier: "Test Carrier", country }`, and
`…002`/`…003` are unknown. Spam reputation has its own test answers, listed below.

### Spam reputation (`number.spam`, alias `spam`)

Spam reputation is a limited-access service. Keys without access get `service_disabled`. It tells you whether a number
appears in spam and nuisance-call **reports**: telecom-regulator actions, government nuisance-call complaint data and
community spam-report sites. It also tells you whether the number was recently offered as an unassigned number, which
can mean a spoofed caller ID or a fake lead. Countries: all, except sanctioned countries (Cuba, Iran, North Korea,
Syria, Russia, Belarus, Venezuela), which answer `unsupported_country` and are free. Works in real time and in bulk.

```ts
import type { SpamAttributes } from "mobilevalidate";

const { data } = await mv.lookup(["+447700900001"], { checks: ["spam"] });
const spam = data?.results[0]?.checks?.["number.spam"];
if (spam?.status === "completed") {
  const a = spam.attributes as SpamAttributes;
  console.log(a.risk_level, a.risk_score, a.reason_regulator, a.top_category); // test key: "high" 95 true "robocall"
}
```

- `risk_level` is `high | medium | low | no_reports`. `risk_score` is an integer from 0 to 100.
- Boolean reasons: `reason_regulator`, `reason_government`, `reason_community`, `reason_unassigned`.
- Other fields: `voip_range` (a hint only, it adds no points), `top_category`, `first_seen` / `last_seen` (`YYYY-MM`)
  and `sources` (an integer).
- **`no_reports` is not "safe".** It only means no reports are known for the number. Combine it with other checks.
- Every `risk_level`, including `no_reports`, is a conclusive answer and is billed. `unknown` and `unsupported_country`
  are free.
- Test keys:
  - `…001` is high: score 95, regulator and community reasons, `robocall`, 2 sources.
  - `…002` is `no_reports` (score 0).
  - `…003` is unknown (`UPSTREAM_TIMEOUT`).
  - `…004` is pending, then `medium`.
  - `…005` is `unsupported_country`.

Live network status (`number.hlr`, alias `hlr`) covers reachability, porting, roaming and the current network. It is
**coming soon**. Until it is switched on, the API refuses it with `service_disabled`.

## Test values

These work with every test key, including the sandbox key. They are also exported as `TEST_NUMBERS` and `TEST_EMAILS`.
Full list: <https://mobilevalidate.com/docs/test-values>.

| Number | `TEST_NUMBERS.` | Result |
|---|---|---|
| `+447700900001` | `registered` | registered |
| `+447700900002` | `notRegistered` | not registered |
| `+447700900003` | `unknown` | unknown (`registered: null`, `reason: UPSTREAM_TIMEOUT`) |
| `+447700900004` | `pending` | pending for about 5 s, then registered (shows the automatic wait) |
| `+447700900005` | `unsupportedCountry` | `unsupported_country` |
| `+447700900006` | `business` | registered, business account |
| `+447700900429` | `rateLimited` | request fails with `rate_limited` |
| `+447700900402` | `insufficientBalance` | request fails with `insufficient_balance` |

| E-mail address (`@test.mobilevalidate.com`) | `TEST_EMAILS.` | Result |
|---|---|---|
| `registered@` | `registered` | registered |
| `not-registered@` | `notRegistered` | not registered |
| `unknown@` | `unknown` | unknown (`reason: UPSTREAM_TIMEOUT`) |
| `pending@` | `pending` | pending for about 5 s, then registered |
| `unsupported@` | `unsupported` | unknown (`reason: UNSUPPORTED_PROVIDER`) |
| `rate-limited@` / `no-balance@` | `rateLimited` / `insufficientBalance` | request fails with `rate_limited` / `insufficient_balance` |

With a personal test key, any other address on the test domain gets a fixed yes/no per address and service. Live keys
get `test_number_only` for the test range and the test domain.

## Client options

```ts
new MobileValidate({
  apiKey: "mv_test_...",        // default: env MOBILEVALIDATE_API_KEY
  sandbox: false,               // true → the public sandbox key (ignores the env key; an explicit apiKey still wins)
  baseUrl: "https://api.mobilevalidate.com", // default; env MOBILEVALIDATE_BASE_URL also honoured
  timeoutMs: 30_000,            // per HTTP request; server long-poll time is added automatically
  waitTimeoutMs: 60_000,        // overall wait budget for lookup() / whatsapp.check()
  maxRetries: 2,                // retryable errors only (429, 5xx, network, timeouts, idempotency in progress)
  throwOnError: false,          // true → throw the typed error instead of returning { error }
  fetch: customFetch,           // optional (proxies, tests)
});
```

Every method also accepts `timeoutMs`, `maxRetries` and `signal` (an `AbortSignal`) for that one call:

```ts
await mv.lookup("+447700900001", { checks: ["whatsapp"], timeoutMs: 5_000, maxRetries: 0 });
```

## Methods

| Method | API |
|---|---|
| `lookup(numbers, { checks, defaultCountry, maxAge, wait, waitTimeoutMs, maxCost, metadata, webhookEndpointId })` | `POST /v1/lookup`, then `GET /v1/lookups/{id}?wait=` until done |
| `lookup({ numbers?, emails?, checks, …same options })` | Same, with e-mail addresses (≤ 100 numbers + e-mails in total) |
| `whatsapp.check(numbers, opts)` | Same as `lookup` (kept for compatibility; default check `whatsapp`) |
| `services()` | `GET /v1/services`: catalog for your key (real time / bulk, prices, attributes) |
| `lookups.get(id, { wait })` | `GET /v1/lookups/{id}` |
| `jobs.estimate(params)` / `jobs.create(params)` | `POST /v1/jobs/estimate` / `POST /v1/jobs` (`numbers` and/or `emails`, ≤ 50,000 together) |
| `jobs.get(id, { wait })`, `jobs.cancel(id)` | `GET/DELETE /v1/jobs/{id}` |
| `jobs.download(id, { format })` | `GET …/download`: the whole file as a stream (`body`, `text()`, and `rows()` for `ndjson`) |
| `jobs.wait(id, { timeoutMs })` | Long-polls `GET /v1/jobs/{id}` until completed, failed or cancelled |
| `jobs.results(id, { registered, status, service, limit })` | Async iterator over **every page** of `GET …/results` (one item per number or e-mail) |
| `jobs.resultsPage(id, params)` | A single page (`data`, `has_more`, `next_cursor`) |
| `account.get()`, `limits.get()`, `usage.get({ from, to, groupBy })` | `GET /v1/account`, `/v1/limits`, `/v1/usage` |
| `webhookEndpoints.create/list/delete/test` | `/v1/webhook_endpoints` |
| `webhooks.verify(rawBody, headers, secret)` | Standard Webhooks signature check |

Notes:
- Money is always a decimal string (`{ amount: "0.0012", currency: "USD" }`). `maxCost` also accepts `"0.05"` or `0.05`.
- `maxAge` takes seconds, or a string like `"30m"`, `"24h"` or `"7d"`. `0` forces a fresh check, which is billed.
- `wait: 0` returns immediately, possibly with `status: "pending"`. You can then poll `lookups.get` or use a webhook.
- Enums are open and responses may gain fields. Your code should tolerate values it doesn't know.
- Result rows carry `kind`:
  - `"phone"` rows have `e164`, `country` and `number_status`. A missing `kind` also means `"phone"`.
  - `"email"` rows have `email` and `email_status` (`valid`, `invalid_email`, `duplicate`, `suppressed`). `email` is
    normalized (trimmed and lowercased) and is `null` if invalid.
  - Rows come numbers first, then e-mails. Invalid rows may carry a `suggestion`.
- E-mails without an e-mail check are refused with `invalid_request` (`param: "checks"`), and so are numbers without a
  phone check.
- Twenty or more addresses on one domain that differ only by digits (`john1@…`, `john2@…`) are refused with
  `suspected_enumeration`. E-mail checks are for fraud prevention and deliverability, not list building.

## Bulk jobs

```ts
const { data: est } = await mv.jobs.estimate({ numbers: list, checks: ["whatsapp", "signal"] });
console.log(est?.max_cost?.amount);                        // e.g. "0.24"; free, nothing is charged
const { data: job } = await mv.jobs.create({ numbers: list, checks: ["whatsapp", "signal"], maxCost: est!.max_cost!.amount });
const { data: done } = await mv.jobs.wait(job!.id);        // long-polls until completed / failed / cancelled
for await (const item of mv.jobs.results(done!.id, { registered: true, service: "signal" })) {
  console.log(item.e164);                                  // every page, fetched as you iterate
}
// job.progress.total = rows; job.progress.checks_total = rows × services

const { data: file } = await mv.jobs.download(done!.id);   // CSV by default: file.text(), or stream file.body
const { data: nd } = await mv.jobs.download(done!.id, { format: "ndjson" });
for await (const row of nd!.rows()) console.log(row.row_no, row.e164);
```

## Errors

`error` is an instance of a class for its code. All of them extend `MobileValidateError`, and every error from an HTTP
response also extends `APIError`.

```ts
import { RateLimitedError, SandboxMagicOnlyError, ServiceDisabledError } from "mobilevalidate";

const { data, error, requestId } = await mv.lookup("+447700900001", { checks: ["whatsapp", "signal"] });
if (error instanceof ServiceDisabledError) console.log(error.suggestion); // e.g. which checks are available in real time
else if (error instanceof RateLimitedError) console.log("retry in", error.retryAfterMs, "ms"); // already retried twice
else if (error) console.log(error.code, error.message, error.docUrl, requestId);
```

| Field | Meaning |
|---|---|
| `code` | Stable error code (see the table below and <https://mobilevalidate.com/docs/errors>) |
| `status` | HTTP status, or `null` when no response was received |
| `retryable` | `true` when the same request can succeed later. The SDK has already retried it `maxRetries` times. |
| `param` | The request field the error is about, e.g. `numbers` or `checks` |
| `suggestion` | A plain-English hint on how to fix the request, when the API has one |
| `docUrl`, `requestId`, `retryAfterMs` | Docs link, the request's `x-request-id`, and the server's Retry-After hint |

| Code | Class | Code | Class |
|---|---|---|---|
| `invalid_request` | `InvalidRequestError` | `not_found` | `NotFoundError` |
| `too_many_numbers` | `TooManyNumbersError` | `idempotency_key_reused` | `IdempotencyKeyReusedError` |
| `test_number_only` | `TestNumberOnlyError` | `idempotency_request_in_progress` | `IdempotencyRequestInProgressError` |
| `invalid_cursor` | `InvalidCursorError` | `test_key_exists` | `TestKeyExistsError` |
| `unauthorized` | `UnauthorizedError` (alias `AuthenticationError`) | `payload_too_large` | `PayloadTooLargeError` |
| `insufficient_balance` | `InsufficientBalanceError` | `rate_limited` | `RateLimitedError` (alias `RateLimitError`) |
| `cost_limit_exceeded` | `CostLimitExceededError` | `daily_cap_reached` | `DailyCapReachedError` |
| `insufficient_scope` | `InsufficientScopeError` | `spend_cap_reached` | `SpendCapReachedError` |
| `service_disabled` | `ServiceDisabledError` | `internal_error` | `InternalServerError` |
| `sandbox_magic_only` | `SandboxMagicOnlyError` | `temporarily_unavailable` | `TemporarilyUnavailableError` |
| `suspected_enumeration` | `SuspectedEnumerationError` | *(unknown code)* | `APIError` |

The SDK adds its own client-side errors:
- `APIConnectionError` (`connection_error`), with its subclass `APITimeoutError` (`timeout`)
- `MissingApiKeyError` (`missing_api_key`)
- `InvalidArgumentError` (`invalid_argument`)
- `InvalidResponseError` (`invalid_response`)

Per-number problems are not errors: invalid, duplicate and unknown numbers appear in each row's `number_status` and
`checks[code].status`.

## Webhooks

```ts
import { verifyWebhook } from "mobilevalidate/webhooks";

export async function POST(req: Request) {
  const raw = await req.text();                               // the raw body, not re-serialized JSON
  const event = await verifyWebhook(raw, req.headers, process.env.MOBILEVALIDATE_WEBHOOK_SECRET!); // throws on failure
  if (event.type === "job.completed") { /* fetch the rows with mv.jobs.results(event.data.id) */ }
  return new Response(null, { status: 204 });
}
```

Verification computes an HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${body}` and compares it with
`webhook-signature: v1,<base64>`. Several signatures separated by spaces are accepted, which covers secret rotation.
Secrets are `whsec_<base64>`, as the API issues them. Timestamps may be up to 5 minutes off (`toleranceSeconds`), and
signatures are compared in constant time. `signWebhook(secret, id, timestamp, body)` builds a signature so you can test
your receiver locally. The CLI can do the same with `mobilevalidate webhooks sign`.

## CLI

The CLI comes with the package. Run it with `npx mobilevalidate …`, or install it globally with
`npm install -g mobilevalidate` to get a `mobilevalidate` command. `mobilevalidate --help` prints the full usage.

```bash
mobilevalidate check <number|email...|-> [--checks whatsapp,telegram,email] [--country GB] [--max-age 7d] [--wait 60] [--max-cost 1.00] [--json]
mobilevalidate check-email <address...|-> [--checks email,gmail]
mobilevalidate services [--json]
mobilevalidate lookup <lkp_id> [--wait 30]
mobilevalidate jobs create --file list.csv [--checks whatsapp,email] [--wait [seconds]]
mobilevalidate jobs get <job_id> [--wait 30]
mobilevalidate jobs results <job_id> [--registered true|false|null] [--limit 500]
mobilevalidate jobs download <job_id> [--format csv|ndjson] [--output results.csv]
mobilevalidate jobs cancel <job_id>
mobilevalidate webhooks verify --secret whsec_… --file body.json --headers headers.txt   # or --id/--timestamp/--signature
mobilevalidate webhooks sign --secret whsec_… --file body.json                           # headers for testing your receiver
mobilevalidate webhooks list | test <endpoint_id>
mobilevalidate account | limits
```

- **Key:** `--sandbox` uses the public sandbox key. Otherwise the CLI reads env `MOBILEVALIDATE_API_KEY`, or
  `--api-key`. The CLI never prints the key.
- **API URL:** `--base-url` or env `MOBILEVALIDATE_BASE_URL`. The default is `https://api.mobilevalidate.com`.
- **`check` input:** it accepts numbers and e-mail addresses together. The default checks are `whatsapp` for numbers
  and `email` for addresses. With several `--checks` you get one table column per service. `spam` gets two columns:
  `SPAM RISK` and `SPAM SCORE`.
- **Output:** a coloured table in a terminal (turn colours off with `--no-color` or `NO_COLOR`). When piped, the CLI
  prints NDJSON, one result per line. `--json` prints a single JSON document.
- **Errors:** the CLI prints the error code and message, then the API's **suggestion**, the docs link and the request
  ID, each on its own line.
- **stdin:** `-` reads numbers and addresses from stdin, one per line (commas and tabs also work):
  `cat numbers.txt | mobilevalidate check -`.
- **CSV files:** the CLI uses the `phone`, `number`, `msisdn`, `mobile` or `e164` column and/or the `email` column if
  they exist. Otherwise it uses the first column, and cells containing `@` are sent as e-mails.
- **`jobs create --wait`:** waits for the job (default up to 600 s), then prints its results.
- **`check-email` fallback:** if a requested e-mail check is bulk only (e.g. `gmail`), `check-email` runs a job and
  waits for it within `--wait`.
- **Exit codes:**
  - `0` ok
  - `1` request error or invalid webhook signature
  - `2` usage error
  - `3` at least one result is unknown, pending or invalid

## Use with AI agents (MCP)

The hosted MCP server at `https://mcp.mobilevalidate.com/mcp` exposes the same checks as MCP tools for Claude, Cursor
and other agents. Use an agent key or a test key. The local stdio package `@mobilevalidate/mcp` is coming soon on npm.
See <https://mobilevalidate.com/docs/mcp>.

## Security notes

- Keep API keys server-side. Do not ship `mv_live_…` keys in browser or mobile bundles; call the API from your backend.
- Test keys (`mv_test_…`) are safe for CI and demos. They never reach a network and are never billed.
- For agents and automations use agent keys (`mv_agent_…`). They are scoped and have a daily spend cap.
- Pass the key via `MOBILEVALIDATE_API_KEY` rather than `--api-key`, so it does not end up in shell history or process
  lists.
- Use `maxCost` / `--max-cost` to cap what a single request may spend.
- Phone numbers and e-mail addresses are sent only in POST bodies, never in URLs. Don't log full numbers in your own
  code either; mask them (`+44•••••••01`).
- Only check numbers and addresses you have a legitimate relationship with. Runs of consecutive numbers or
  digit-variant addresses are refused (`suspected_enumeration`), and daily caps apply.
- Verify webhooks with `verifyWebhook` on the raw request body.

## Versioning

The SDK follows semantic versioning and targets API `/v1`. Within `/v1`, responses may gain fields and enums may gain
values, so tolerate values you don't know. Policy: <https://mobilevalidate.com/docs/versioning>.

## Maintainers

- **Source layout:** TypeScript in `src/`. Imports use `.ts` extensions, so Node 24 and `tsx` run it directly inside
  the monorepo.
- **Published package:** only `dist/` (ESM `*.js` + `*.d.ts`, CommonJS `cjs/*.cjs` + `*.d.cts`), `README.md` and
  `LICENSE`.
- **Entry points:** `package.json` points `main` / `exports` / `bin` at `src/` for workspace consumers. `publishConfig`
  overrides them to `dist/` in the packed tarball. So always pack with **pnpm** (`pnpm pack` /
  `ops/publish-packages.sh`), never plain `npm pack` / `npm publish` from this directory.

```bash
pnpm --filter ./packages/sdk run typecheck
pnpm --filter ./packages/sdk test
pnpm --filter ./packages/sdk run build            # → dist/ (ESM) + dist/cjs/ (CJS)
pnpm --filter ./packages/sdk run gen:services     # refresh src/services.generated.ts + the README table from the catalog
pnpm --filter ./packages/sdk run gen:collections  # Postman / Bruno / .http collections from docs/api/openapi.yaml
ops/publish-packages.sh                           # build, test, pack, leak-scan, dry-run publish (npm + PyPI)
```

**Release checklist:**
1. Bump `version` in `package.json` **and** `src/version.ts`. A test checks that they match.
2. Bump the MCP package too, since it pins this version.
3. Run the publish script.

## License

MIT © 2026 BroadNet Technologies Inc. See [LICENSE](./LICENSE).
