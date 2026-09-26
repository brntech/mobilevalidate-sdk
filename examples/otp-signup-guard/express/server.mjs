// OTP / sign-up guard (Express). Before sending a one-time code, check the number once:
//   invalid → ask the user to fix it · WhatsApp registered → send the code on WhatsApp · otherwise → SMS.
// Run:  MOBILEVALIDATE_API_KEY=mv_test_… node server.mjs   (or no key: the public sandbox key, test values only)
import express from "express";
import { MobileValidate } from "mobilevalidate";
import { decideOnError, decideOtpChannel, maskNumber } from "./otp-decision.mjs";

// Uses MOBILEVALIDATE_API_KEY when set; otherwise the public sandbox key (only the documented test values work).
export function createClient() {
  return process.env.MOBILEVALIDATE_API_KEY ? new MobileValidate() : new MobileValidate({ sandbox: true });
}

export function createApp(mv = createClient()) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));

  app.post("/signup/check", async (req, res) => {
    const phone = typeof req.body?.phone === "string" ? req.body.phone : "";
    if (!phone) return res.status(400).json({ action: "fix_number", suggestion: "Enter your mobile number." });

    // One real-time lookup: WhatsApp registration + carrier/line type (carrier is beta; drop it if you don't need it).
    const { data, error, requestId } = await mv.lookup(phone, {
      checks: ["whatsapp", "carrier"],
      defaultCountry: req.body?.country, // lets users type national numbers such as 07700 900001
      wait: 5, waitTimeoutMs: 8_000, // keep sign-up snappy; a pending answer falls back to SMS
    });

    const decision = error ? decideOnError(error) : decideOtpChannel(data.results[0]);
    // Log the decision with a masked number and the request id (quote it to support). Never log the full number.
    console.log(JSON.stringify({ phone: maskNumber(phone), action: decision.action, reason: decision.reason, requestId }));

    if (decision.action === "error") return res.status(502).json(decision);
    if (decision.action === "fix_number") return res.status(422).json(decision);
    // Here you would call your WhatsApp or SMS OTP provider. This example just returns the decision.
    return res.json(decision);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`OTP guard on http://localhost:${port}/signup/check`));
}
