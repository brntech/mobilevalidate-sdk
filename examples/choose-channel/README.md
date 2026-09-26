# Choose the channel: WhatsApp, Telegram, Viber or SMS

One lookup with several checks, then pick the first channel (in **your** preference order, e.g. cheapest first) where
the number is known to be registered. Nothing registered → SMS; a landline (optional carrier check) → voice.

```bash
npm install
node choose-channel.mjs +447700900001 +447700900002 +447700900003
# +44••••••••01 → whatsapp (whatsapp_registered)
# +44••••••••02 → sms (fallback_none_registered)
# +44••••••••03 → sms (fallback_some_unknown; unknown: whatsapp,telegram,viber)
```

- `registered: null` means **unknown** (not billed). The recipe still falls back to SMS but reports the unknown
  channels separately, so you can retry later instead of recording a "no".
- Up to 100 numbers per lookup. For bigger lists use a bulk job (see the CSV list cleaner).
- Use it to pick the channel for messages people asked for (OTP, order updates, reminders). MobileValidate is not
  meant for unsolicited bulk messaging.
