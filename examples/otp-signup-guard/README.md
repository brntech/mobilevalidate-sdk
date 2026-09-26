# OTP / sign-up guard

Check a phone number **once, before you send a one-time code**:

| Result | What the guard does |
|---|---|
| `number_status` is not `valid` | Ask the user to fix the number and show the API's `suggestion` (e.g. a missing country code). HTTP 422. |
| `whatsapp.registered` → `registered: true` | Send the code on WhatsApp. |
| `registered: false` | Send the code by SMS. |
| `registered: null` (unknown, never billed) | Send the code by SMS. Keep "unknown" as its own state: never store it as "not registered". |
| carrier `line_type` is `voip`, `premium_rate`, `toll_free` or `shared_cost` | Add friction (e.g. a CAPTCHA). Not a block on its own. The carrier check is in beta. |
| The check itself fails with a temporary error (`retryable`, timeout, network) | Fail open: send by SMS. Never block sign-ups because a check was unavailable. |
| Any other error | Return it with its `suggestion`, so it gets fixed. |

Two variants with the same rules; the decision logic is a pure module in each, so you can unit-test it:

- [`express/`](express): `POST /signup/check` with `{ "phone": "+447700900001", "country"?: "GB" }`
- [`nextjs/`](nextjs): App Router route handler `app/api/otp/route.ts` (`POST /api/otp`)

## Run it

```bash
cd express && npm install
node server.mjs                 # no key: the public sandbox key (test values only)
curl -s localhost:3000/signup/check -H 'content-type: application/json' -d '{"phone":"+447700900001"}'
# {"action":"send_whatsapp","reason":"whatsapp_registered","extraVerification":false}
```

With your own key: `MOBILEVALIDATE_API_KEY=mv_test_… node server.mjs` (get one at <https://mobilevalidate.com/get-test-key>).
Keep the key on the server; never put it in a `NEXT_PUBLIC_…` variable or a browser bundle.

## Test values

`+447700900001` WhatsApp · `+447700900002` SMS (not registered) · `+447700900003` SMS (unknown) ·
`+447700900004` pending for about 5 s, then WhatsApp · `7700 900001` (personal test key, no country) → fix the number.
All values: <https://mobilevalidate.com/docs/test-values>.

The guard logs the decision with a **masked** number (`+44••••••••01`) and the `requestId`. Never log full numbers.
