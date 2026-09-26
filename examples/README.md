# MobileValidate examples

Copy-paste recipes for the [MobileValidate](https://mobilevalidate.com) API — *know before you send*. Every recipe is
tested and uses only the documented **test values**, so it runs as-is with the public sandbox key (no signup).

| Recipe | Language | What it shows |
|---|---|---|
| [OTP / sign-up guard](otp-signup-guard) | Node (Express, Next.js) | Fix invalid numbers, send the code on WhatsApp or SMS, extra friction for VoIP |
| [CSV list cleaner](csv-list-cleaner) | Python | Dedupe, bulk job, auto-pagination, a verdict per row |
| [Webhook receiver](webhook-receiver) | Node, Python | Signature check on the raw body, fast 2xx, duplicate handling |
| [Choose the channel](choose-channel) | Node | WhatsApp vs Telegram vs Viber vs SMS from one lookup |
| [E-mail check at sign-up](email-signup-check) | Node, Python | Typos, dead mailboxes, unknown answers |

For coding agents: [`AGENTS.md`](AGENTS.md) and the agent skill in [`skills/mobilevalidate`](skills/mobilevalidate/SKILL.md).

## 30-second start

```bash
npx mobilevalidate check +447700900001 +447700900002 registered@test.mobilevalidate.com --sandbox
```

```js
// check.mjs — Node >= 18
import { MobileValidate } from "mobilevalidate";

const mv = new MobileValidate({ sandbox: true }); // or new MobileValidate() with MOBILEVALIDATE_API_KEY set
const { data, error } = await mv.lookup("+447700900001", { checks: ["whatsapp"] });
if (error) console.error(error.code, error.suggestion);
else console.log(data.results[0].checks["whatsapp.registered"].registered); // true
```

```python
from mobilevalidate import MobileValidate

mv = MobileValidate(sandbox=True)  # or MobileValidate() with MOBILEVALIDATE_API_KEY set
lookup = mv.lookup("+447700900001", checks=["whatsapp"])
print(lookup["results"][0]["checks"]["whatsapp.registered"]["registered"])  # True
```

The npm and PyPI packages are coming soon. Until they are published, see <https://mobilevalidate.com/docs/sdk>.

## Keys

- **Public sandbox key** (`sandbox: true`): only the test values below, per-IP limits, bulk jobs of up to 10 rows, no
  webhooks, never billed.
- **Personal test key** (`mv_test_…`, <https://mobilevalidate.com/get-test-key>): the test values give the documented
  answers and any other number gets a fake but stable answer. Nothing reaches a network; nothing is billed.
- **Live key** (`mv_live_…`): real checks. Keep it on your server.

Put the key in `MOBILEVALIDATE_API_KEY`; every recipe reads it and falls back to the sandbox key when it is not set.

## Test values

| Number | Answer | E-mail (`@test.mobilevalidate.com`) | Answer |
|---|---|---|---|
| `+447700900001` | registered | `registered@` | registered |
| `+447700900002` | not registered | `not-registered@` | not registered |
| `+447700900003` | unknown | `unknown@` | unknown |
| `+447700900004` | pending ~5 s, then registered | `pending@` | pending ~5 s, then registered |
| `+447700900005` | unsupported country | `unsupported@` | unknown |
| `+447700900006` | registered, business | | |
| `+447700900429` / `+447700900402` | error `rate_limited` / `insufficient_balance` | `rate-limited@` / `no-balance@` | same errors |

Full list: <https://mobilevalidate.com/docs/test-values>.

## Run the tests

```bash
npm test            # offline: installs express + a Python venv (.venv), runs every recipe against a mock API
npm run test:live   # the same tests against https://api.mobilevalidate.com with the public sandbox key
```

`test:live` also runs the personal-test-key cases when `MOBILEVALIDATE_TEST_KEY=mv_test_…` is set. Requirements:
Node ≥ 22.18 (the Next.js test is TypeScript) and Python ≥ 3.9.

## License

MIT. See [LICENSE](LICENSE). Platform names are used descriptively only; MobileValidate is not affiliated with,
endorsed or sponsored by any of these platforms.
