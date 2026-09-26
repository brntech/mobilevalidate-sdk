// Next.js App Router route handler: POST /api/otp { "phone": "+447700900001", "country"?: "GB" }
// Decides how to send the one-time code before you send it. Runs on the Node.js or Edge runtime.
// Key: MOBILEVALIDATE_API_KEY (server-side only — never NEXT_PUBLIC_…). Without it: the public sandbox key.
import { MobileValidate } from "mobilevalidate";
import { decideOnError, decideOtpChannel, maskNumber } from "../../../lib/otp-decision.ts";

const mv = process.env.MOBILEVALIDATE_API_KEY ? new MobileValidate() : new MobileValidate({ sandbox: true });

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { phone?: unknown; country?: unknown };
  const phone = typeof body.phone === "string" ? body.phone : "";
  if (!phone) return Response.json({ action: "fix_number", suggestion: "Enter your mobile number." }, { status: 400 });

  const { data, error, requestId } = await mv.lookup(phone, {
    checks: ["whatsapp", "carrier"], // carrier (line type) is beta; drop it if you don't need it
    defaultCountry: typeof body.country === "string" ? body.country : undefined,
    wait: 5,
    waitTimeoutMs: 8_000,
  });
  const decision = error ? decideOnError(error) : decideOtpChannel(data.results[0]!);
  console.log(JSON.stringify({ phone: maskNumber(phone), action: decision.action, reason: decision.reason, requestId }));

  if (decision.action === "error") return Response.json(decision, { status: 502 });
  if (decision.action === "fix_number") return Response.json(decision, { status: 422 });
  // Send the code with your WhatsApp or SMS OTP provider here.
  return Response.json(decision);
}
