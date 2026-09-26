# E-mail check at sign-up

Catch typos and dead mailboxes before you send the confirmation e-mail.

| Result | Decision |
|---|---|
| `email_status` is not `valid` | `fix`: show the API's `suggestion` (e.g. a mistyped domain). |
| `email.valid` → `registered: false` | `confirm`: "We couldn't find this mailbox. Is the address spelled correctly?" Let the user continue if they insist. |
| `registered: true` | `allow` |
| `registered: null` (unknown, never billed) | `allow`: don't block a real user on an uncertain answer. |
| The check fails | `allow` (fail open) and log the error code and request id, never the address. |

```bash
npm install && node email-check.mjs registered@test.mobilevalidate.com
pip install mobilevalidate-sdk && python email_check.py not-registered@test.mobilevalidate.com
```

Test addresses (domain `test.mobilevalidate.com`): `registered@`, `not-registered@`, `unknown@`, `pending@`.
Answers are yes / no / unknown only — never names or profiles.
