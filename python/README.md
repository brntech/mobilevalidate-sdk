# mobilevalidate (Python)

Official Python client for the [MobileValidate](https://mobilevalidate.com) API — *know before you send*. Check
whether phone numbers are registered on WhatsApp, Telegram, Viber and many other services, look up carrier and line
type, get a report-based spam reputation, and verify e-mail addresses — several checks in one request.

Every answer is `registered: True | False | None` (or, for data services such as the carrier lookup or spam
reputation, a whitelisted set of `attributes`). `None` means **unknown**, and unknown answers are never billed. Each
answer also carries `confidence`, `checked_at`, `cached` and `billed`.

- **Sync and async** clients (`MobileValidate`, `AsyncMobileValidate`) on [httpx](https://www.python-httpx.org/).
- **Typed**: TypedDicts for every response, `py.typed`, one exception class per API error code. No pydantic.
- **Safe retries**: every POST gets an automatic `Idempotency-Key`; retryable errors (429, 5xx, network, timeouts)
  are retried twice with jittered exponential backoff, honouring `Retry-After`.
- **Waits for slow answers**: `lookup()` long-polls until the lookup completes or the wait budget runs out.
- **Webhook verification** (Standard Webhooks) with the standard library only.
- Python 3.9 or later.

Docs: <https://mobilevalidate.com/docs/sdk> · API reference: <https://mobilevalidate.com/docs/api-reference> ·
Test values: <https://mobilevalidate.com/docs/test-values>

## Install

```bash
pip install mobilevalidate-sdk
```

## 30-second quickstart (no signup)

The public **sandbox key** is built in. It answers only the documented test values below, so you can run this as
pasted:

```python
from mobilevalidate import MobileValidate

mv = MobileValidate(sandbox=True)

lookup = mv.lookup(["+447700900001", "+447700900002", "+447700900003"], checks=["whatsapp"])
for row in lookup["results"]:
    answer = row["checks"]["whatsapp.registered"]
    print(row["e164"], answer["registered"], answer["status"])
# +447700900001 True completed
# +447700900002 False completed
# +447700900003 None unknown
print(lookup.request_id)
```

Then use your own key: set `MOBILEVALIDATE_API_KEY` and drop `sandbox=True`.

```python
mv = MobileValidate()                      # reads MOBILEVALIDATE_API_KEY (and MOBILEVALIDATE_BASE_URL if set)
answer = mv.lookup("+447700900001", checks=["whatsapp"])["results"][0]["checks"]["whatsapp.registered"]
if answer["registered"] is True:
    ...  # send on WhatsApp
elif answer["registered"] is False:
    ...  # fall back to SMS
else:
    ...  # unknown: answer["status"] / answer["reason"] explain why; not billed
```

## Keys and test mode

| Key | Where from | What it answers |
|---|---|---|
| Sandbox key (`MobileValidate(sandbox=True)`) | built into the SDK; public by design | Only the test values below. Anything else is refused with `SandboxMagicOnlyError`. Limited per IP (30/min, 1,000/day), bulk jobs up to 10 rows, no webhooks. |
| Personal test key `mv_test_…` | [Get a test key](https://mobilevalidate.com/get-test-key) | The test values below exactly as documented; **any other number or address gets a fake but stable answer** (the same input always gives the same result). Bulk jobs and webhooks work. |
| Live key `mv_live_…` | after your access request is approved | Real checks, billed per conclusive answer. |

Test mode (sandbox and personal test keys) never reaches any network and is never billed.

### Test numbers

| Number | Result |
|---|---|
| `+447700900001` | registered |
| `+447700900002` | not registered |
| `+447700900003` | unknown (`registered: None`, `reason: UPSTREAM_TIMEOUT`) |
| `+447700900004` | pending for about 5 s, then registered (shows the auto-wait) |
| `+447700900005` | `unsupported_country` |
| `+447700900006` | registered, business account |
| `+447700900429` / `+447700900402` | request fails with `RateLimitedError` / `InsufficientBalanceError` |

### Test e-mail addresses

| Address | Result |
|---|---|
| `registered@test.mobilevalidate.com` | registered |
| `not-registered@test.mobilevalidate.com` | not registered |
| `unknown@test.mobilevalidate.com` | unknown (`reason: UPSTREAM_TIMEOUT`) |
| `pending@test.mobilevalidate.com` | pending for about 5 s, then registered |
| `unsupported@test.mobilevalidate.com` | unknown (`reason: UNSUPPORTED_PROVIDER`) |
| `rate-limited@…` / `no-balance@…` | request fails with `RateLimitedError` / `InsufficientBalanceError` |

The same values are available in code: `mobilevalidate.TEST_NUMBERS["registered"]`, `TEST_NUMBERS["not_registered"]`, … and `mobilevalidate.TEST_EMAILS["registered"]` (the same keys as the Node SDK, in snake_case).

## Several checks, numbers and e-mails

```python
lookup = mv.lookup(
    ["+447700900001"],
    emails=["registered@test.mobilevalidate.com"],
    checks=["whatsapp", "telegram", "carrier", "email"],
)
for row in lookup["results"]:                      # rows: numbers first, then e-mails
    if row.get("kind") == "email":
        print(row["email"], row["checks"]["email.valid"]["registered"])
    else:
        print(row["e164"], row["checks"]["telegram.registered"]["registered"], row["checks"]["network.carrier"]["attributes"])
print(lookup["summary"].get("by_service"))
catalog = mv.services()                            # what your key can use, with prices
```

Phone checks run on numbers, e-mail checks on e-mails (≤ 100 in total per lookup). Invalid rows carry
`number_status` / `email_status` and, when the API can tell, a plain-English `suggestion` (for example a missing
country code). E-mail answers are yes / no / unknown only — never names, photos or profiles.

Options: `checks`, `default_country` (ISO alpha-2 for national-format numbers), `max_age` (seconds or `"30m"`,
`"24h"`, `"7d"`; `0` forces a fresh, billed check), `wait` (seconds the server waits, 0–30, default 10; `0` returns
immediately), `wait_timeout` (overall polling budget, default 60 s), `max_cost` (`"0.05"` — refuses the request if it
could cost more), `metadata`, `webhook_endpoint_id`, `idempotency_key`, `timeout`, `max_retries`.

Money is always a decimal string: `{"amount": "0.0012", "currency": "USD"}`.

## Bulk jobs

```python
est = mv.jobs.estimate(numbers=numbers, checks=["whatsapp"])
print(est["max_cost"]["amount"])
job = mv.jobs.create(numbers=numbers, checks=["whatsapp"], max_cost=est["max_cost"]["amount"])
job = mv.jobs.wait(job["id"], wait_timeout=600)        # long-polls until completed / failed / cancelled
for row in mv.jobs.results(job["id"], registered=True):  # follows every cursor page for you
    print(row["e164"])
csv_text = mv.jobs.download(job["id"])                           # the whole file as text (CSV, or format="ndjson")
mv.jobs.download_to(job["id"], "results.csv")                    # streams to disk; returns the bytes written
```

`jobs.results_page()` returns a single page; `jobs.get(id, wait=30)` and `jobs.cancel(id)` are also available.

## Errors

Every failure raises a subclass of `MobileValidateError` with `code`, `message`, `status`, `retryable`,
`request_id`, `param`, `doc_url`, `suggestion` and `retry_after`:

```python
from mobilevalidate import MobileValidate, MobileValidateError, InsufficientBalanceError, SandboxMagicOnlyError

try:
    mv.lookup("+447700900402", checks=["whatsapp"])
except InsufficientBalanceError as e:
    print("top up:", e.message, e.request_id)
except SandboxMagicOnlyError as e:
    print(e.suggestion)                                # how to fix it, in plain English
except MobileValidateError as e:
    print(e.code, e.status, e.message, e.suggestion, e.doc_url, e.request_id)
```

| Class | Code | HTTP |
|---|---|---|
| `InvalidRequestError` | `invalid_request` | 400 |
| `TooManyNumbersError` | `too_many_numbers` | 400 |
| `TestNumberOnlyError` | `test_number_only` | 400 |
| `InvalidCursorError` | `invalid_cursor` | 400 |
| `UnauthorizedError` (alias `AuthenticationError`) | `unauthorized` | 401 |
| `InsufficientBalanceError` | `insufficient_balance` | 402 |
| `CostLimitExceededError` | `cost_limit_exceeded` | 402 |
| `InsufficientScopeError` | `insufficient_scope` | 403 |
| `ServiceDisabledError` | `service_disabled` | 403 |
| `SandboxMagicOnlyError` | `sandbox_magic_only` | 403 |
| `SuspectedEnumerationError` | `suspected_enumeration` | 403 |
| `NotFoundError` | `not_found` | 404 |
| `IdempotencyKeyReusedError` | `idempotency_key_reused` | 409 |
| `IdempotencyRequestInProgressError` | `idempotency_request_in_progress` | 409 (retried) |
| `TestKeyExistsError` | `test_key_exists` | 409 |
| `PayloadTooLargeError` | `payload_too_large` | 413 |
| `RateLimitedError` (alias `RateLimitError`) | `rate_limited` | 429 (retried) |
| `DailyCapReachedError` | `daily_cap_reached` | 429 (retried) |
| `SpendCapReachedError` | `spend_cap_reached` | 429 |
| `InternalServerError` | `internal_error` | 500 (retried) |
| `TemporarilyUnavailableError` | `temporarily_unavailable` | 503 (retried) |
| `APIError` | any other API code | — |
| `APIConnectionError` / `APITimeoutError` | `connection_error` / `timeout` | — (retried) |
| `MissingApiKeyError`, `InvalidArgumentError`, `InvalidResponseError` | SDK-side | — |

All API error classes derive from `APIError`. Per-number problems (invalid, duplicate, unknown) are not errors; they
appear in each row's `number_status` / `email_status` and `checks[code]["status"]`.

## Retries and timeouts

```python
mv = MobileValidate(
    timeout=30.0,        # seconds per HTTP request; server long-poll time is added automatically
    max_retries=2,       # retryable errors only; 0 disables
    wait_timeout=60.0,   # overall polling budget for lookup()
)
mv.lookup("+447700900001", timeout=5, max_retries=0)   # per-call overrides
```

Retries use full-jitter exponential backoff (0.5 s, 1 s, … capped at 8 s) or the server's `Retry-After`. A
`Retry-After` above 60 s (for example a daily cap) is raised instead of waited for. The same `Idempotency-Key` is
sent on every attempt, so a retried POST is never charged twice. Every returned object has `.request_id` — quote it
when you contact support.

You can pass your own `httpx.Client` / `httpx.AsyncClient` (`http_client=`) for proxies or custom transports; the SDK
does not close clients it did not create. Use the client as a context manager to close its connection pool.

## Async

```python
import asyncio
from mobilevalidate import AsyncMobileValidate

async def main():
    async with AsyncMobileValidate(sandbox=True) as mv:
        lookup = await mv.lookup("+447700900004", checks=["whatsapp"])   # waits ~5 s for the pending answer
        print(lookup["status"], lookup["results"][0]["checks"]["whatsapp.registered"]["registered"])
        async for row in mv.jobs.results("job_..."):
            ...

asyncio.run(main())
```

## Webhooks

Verify every webhook on the **raw** request body. `verify_webhook` checks an HMAC-SHA256 over
`{webhook-id}.{webhook-timestamp}.{body}` against `webhook-signature: v1,<base64>` (several signatures are allowed
during secret rotation), in constant time, with 5 minutes of clock tolerance. Secrets look like `whsec_<base64>`.

Flask:

```python
import os
from flask import Flask, request
from mobilevalidate import verify_webhook, WebhookVerificationError

app = Flask(__name__)

@app.post("/webhooks/mobilevalidate")
def webhook():
    try:
        event = verify_webhook(request.get_data(), request.headers, os.environ["MOBILEVALIDATE_WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return "", 400
    if event["type"] == "job.completed":
        job_id = event["data"]["id"]      # fetch rows with mv.jobs.results(job_id)
    return "", 204
```

FastAPI:

```python
import os
from fastapi import FastAPI, Request, Response
from mobilevalidate import verify_webhook, WebhookVerificationError

app = FastAPI()

@app.post("/webhooks/mobilevalidate")
async def webhook(request: Request):
    try:
        event = verify_webhook(await request.body(), request.headers, os.environ["MOBILEVALIDATE_WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return Response(status_code=400)
    return Response(status_code=204)
```

Events: `lookup.completed`, `job.completed`, `job.failed`, `job.progress`, `balance.low`, `limits.cap_reached`.
Payloads never contain phone numbers; fetch results with your key. `sign_webhook(secret, msg_id, timestamp, body)`
produces a valid signature for testing your own receiver.

## Other methods

| Method | API |
|---|---|
| `lookups.get(id, wait=0)` | `GET /v1/lookups/{id}` |
| `services()` | `GET /v1/services` |
| `account.get()`, `limits.get()` | `GET /v1/account`, `GET /v1/limits` |
| `usage.get(from_date="2026-09-01", to_date="2026-09-30", group_by="day")` | `GET /v1/usage` |
| `webhook_endpoints.create(url=..., events=[...])`, `.list()`, `.delete(id)`, `.test(id)` | `/v1/webhook_endpoints` |
| `webhooks.verify(raw_body, headers, secret)` | same as `verify_webhook` |

## Security notes

- Keep live keys server-side; pass them via `MOBILEVALIDATE_API_KEY`, not in source code.
- Never log full phone numbers or e-mail addresses; mask them (for example `+44•••••••01`).
- Only check numbers and addresses you have a legitimate relationship with. Runs of consecutive numbers or
  digit-variant addresses are refused (`SuspectedEnumerationError`).
- Use `max_cost` to cap what a single request may spend.

## Versioning

Semantic versioning. The SDK targets API `/v1`; responses may gain fields and enums may gain values within `/v1`, so
tolerate values you don't know (responses are plain dicts and keep unknown fields).

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
.venv/bin/python -m build      # sdist + wheel in dist/
```

## License

MIT © 2026 BroadNet Technologies Inc. See [LICENSE](./LICENSE).
