# Webhook receiver (Node + Python)

Receive `job.completed` and `lookup.completed` events and verify them before you trust them.

| Rule | Why |
|---|---|
| Verify the signature on the **raw body** (`verifyWebhook` / `verify_webhook`) | Re-serialized JSON changes the bytes and the signature fails. |
| Answer 2xx quickly, then work | Slow or failing endpoints are retried. |
| Ignore repeated `webhook-id`s | Deliveries can repeat; keep processed ids in your database. |
| On `job.completed`, fetch the results with your key | Events never contain phone numbers or e-mail addresses. |

- [`node/server.mjs`](node/server.mjs): plain `node:http`, no framework.
- [`python/app.py`](python/app.py): Flask, `request.get_data()`.

## Test it locally

The public sandbox key has no webhooks, so use a personal test key (<https://mobilevalidate.com/get-test-key>) to
register an endpoint. You can test the receiver without any key: sign a sample event yourself.

```bash
export MOBILEVALIDATE_WEBHOOK_SECRET=whsec_$(printf 'local-test-secret' | base64)
node node/server.mjs &                        # or: cd python && flask --app app run --port 3000
npx mobilevalidate webhooks sign --secret "$MOBILEVALIDATE_WEBHOOK_SECRET" --file node/event.json > headers.txt
curl -i localhost:3000/webhooks/mobilevalidate -H 'content-type: application/json' \
  -H "$(sed -n 1p headers.txt)" -H "$(sed -n 2p headers.txt)" -H "$(sed -n 3p headers.txt)" \
  --data-binary @node/event.json               # → 204
npx mobilevalidate webhooks verify --secret "$MOBILEVALIDATE_WEBHOOK_SECRET" --file node/event.json --headers headers.txt
```

The npm and PyPI packages are coming soon; until then run the CLI from a checkout of the SDK.
