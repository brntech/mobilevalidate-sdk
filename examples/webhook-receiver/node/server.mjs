// Webhook receiver (plain node:http, no framework). Verifies the Standard Webhooks signature on the RAW body,
// answers 2xx fast, ignores duplicates (same webhook-id), and handles job.completed by fetching the job's results.
// Run:  MOBILEVALIDATE_WEBHOOK_SECRET=whsec_… MOBILEVALIDATE_API_KEY=mv_test_… node server.mjs
// Note: the public sandbox key has no webhooks — use a personal test key (mobilevalidate.com/get-test-key).
import { createServer } from "node:http";
import { MobileValidate, WebhookVerificationError, verifyWebhook } from "mobilevalidate";

/**
 * @param {{ secret: string, mv?: MobileValidate, onEvent?: (event: any, ctx: { mv: MobileValidate }) => Promise<void> }} opts
 */
export function createWebhookServer({ secret, mv = new MobileValidate(), onEvent = handleEvent }) {
  // Deliveries can repeat (retries): remember processed ids. Use your database (unique index) in production.
  const seen = new Set();

  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/mobilevalidate") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks); // the exact bytes received — never JSON.parse + JSON.stringify before verifying

    let event;
    try {
      event = await verifyWebhook(raw, req.headers, secret); // checks signature + timestamp (±5 min)
    } catch (e) {
      if (!(e instanceof WebhookVerificationError)) throw e;
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
      return;
    }

    const id = String(req.headers["webhook-id"]);
    const duplicate = seen.has(id);
    seen.add(id);
    // Answer first (quickly, 2xx), then do the work: slow endpoints get retried.
    res.writeHead(204).end();
    if (!duplicate) setImmediate(() => onEvent(event, { mv }).catch((err) => console.error("webhook handler failed:", err.message)));
  });
}

/** Default handler: on job.completed, stream the results page by page (auto-pagination). */
export async function handleEvent(event, { mv }) {
  if (event.type === "job.completed") {
    const counts = { registered: 0, not_registered: 0, unknown: 0, invalid: 0 };
    for await (const row of mv.jobs.results(event.data.id)) {
      if ((row.number_status ?? row.email_status) !== "valid") { counts.invalid++; continue; }
      const first = Object.values(row.checks ?? {})[0];
      counts[first?.registered === true ? "registered" : first?.registered === false ? "not_registered" : "unknown"]++;
    }
    console.log(`job ${event.data.id} completed:`, counts); // counts only, never numbers
    return counts;
  }
  if (event.type === "lookup.completed") console.log(`lookup ${event.data.id} completed`);
  // Other types (job.failed, job.progress, balance.low, limits.cap_reached): add handling as needed.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.MOBILEVALIDATE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set MOBILEVALIDATE_WEBHOOK_SECRET (the whsec_… secret shown when you created the endpoint).");
  const port = Number(process.env.PORT ?? 3000);
  createWebhookServer({ secret }).listen(port, () => console.log(`POST http://localhost:${port}/webhooks/mobilevalidate`));
}
