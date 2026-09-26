import { parseArgs } from "node:util";
import { MobileValidate, type MobileValidateOptions } from "./client.ts";
import { MobileValidateError, WebhookVerificationError } from "./errors.ts";
import { SANDBOX_PUBLIC_KEY, TEST_EMAILS, TEST_NUMBERS } from "./sandbox.ts";
import type { CheckResult, Job, Lookup, ResultItem, Service } from "./types.ts";
import { VERSION } from "./version.ts";
import { sign as signWebhook, verifyWebhook } from "./webhooks.ts";

/** CLI logic, separated from the entry point so it can be tested with injected I/O. */
export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  /** Stream bytes to a file (`jobs download --output`). */
  writeFile?: (path: string, body: ReadableStream<Uint8Array>) => Promise<void>;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Unix seconds (tests). */
  now?: () => number;
  createClient?: (opts: MobileValidateOptions) => MobileValidate;
}

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, PARTIAL: 3 } as const;
const LOOKUP_MAX = 100;
const JOB_JSON_MAX = 50_000;

export const USAGE = `Usage: mobilevalidate <command> [options]

Try it now, no signup (public sandbox key, test values only):
  npx mobilevalidate check ${TEST_NUMBERS.registered} ${TEST_NUMBERS.notRegistered} ${TEST_EMAILS.registered} --sandbox

Commands:
  check <number|email...|->    Check up to ${LOOKUP_MAX} numbers and/or e-mail addresses ("-" reads stdin).
                               Default checks: whatsapp for numbers, email for addresses.
  check-email <address...|->   Check e-mail addresses only (--checks email,gmail). Bulk-only e-mail checks run as a
                               job automatically. Answers are yes / no / unknown only.
  services                     Services your key can use (real time / bulk only, prices)
  lookup <id> [--wait s]       Fetch an earlier (possibly pending) check
  jobs create --file <path|->  Create a bulk job from a .txt (one per line) or .csv file (phone and/or email column).
                               Add --wait [s] to wait for it (default up to 600 s) and print the results.
  jobs get <id> [--wait s]     Job status and progress
  jobs results <id>            Job results (--registered true|false|null, --limit n)
  jobs download <id>           Whole result file (--format csv|ndjson, default csv) to stdout or --output <path>
  jobs cancel <id>             Cancel a running job
  webhooks verify              Check a webhook signature: --secret (or env MOBILEVALIDATE_WEBHOOK_SECRET),
                               --file <body|->, and --id/--timestamp/--signature or --headers <file>
  webhooks sign                Print signed headers for a payload, to test your receiver locally (--secret, --file)
  webhooks list | test <id>    List endpoints / send a test event to one
  account                      Balance and today's usage
  limits                       Rate limits and remaining daily allowances
  ("job" works as an alias of "jobs".)

Options:
  --sandbox            Use the public sandbox key (only the test values at mobilevalidate.com/docs/test-values)
  --country <CC>       Default country for national-format numbers (e.g. GB)
  --checks <list>      Comma-separated services, e.g. whatsapp,telegram,viber,carrier,email (see "services")
  --max-age <s>        Accept cached results up to this age (seconds, or 30m / 24h / 7d)
  --wait <s>           Seconds to wait for results (check: default 60; 0 = return immediately)
  --max-cost <usd>     Refuse if the maximum possible cost is higher (e.g. 5.00)
  --json               JSON output (default when stdout is not a terminal: NDJSON for lists)
  --no-color           No colours in tables (also env NO_COLOR)
  --api-key <key>      API key (default: env MOBILEVALIDATE_API_KEY). Prefer the env variable.
  --base-url <url>     API base URL (default: env MOBILEVALIDATE_BASE_URL or https://api.mobilevalidate.com)
  -h, --help           Show help
  -v, --version        Show version

Exit codes: 0 ok, 1 request error or invalid signature, 2 usage error, 3 some results unknown/pending/invalid.
`;

class UsageError extends Error {}

const OPTIONS = {
  "api-key": { type: "string" },
  sandbox: { type: "boolean" },
  "no-color": { type: "boolean" },
  secret: { type: "string" },
  id: { type: "string" },
  timestamp: { type: "string" },
  signature: { type: "string" },
  headers: { type: "string" },
  tolerance: { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean" },
  country: { type: "string" },
  checks: { type: "string" },
  "max-age": { type: "string" },
  wait: { type: "string" },
  "max-cost": { type: "string" },
  file: { type: "string", short: "f" },
  registered: { type: "string" },
  limit: { type: "string" },
  format: { type: "string" },
  output: { type: "string", short: "o" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export type ParsedCli = ReturnType<typeof parseCli>;

/** `--wait` may be given without a value ("wait with the default budget"): normalise it to `--wait=`. */
function normaliseWait(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--wait" && !/^\d+$/.test(argv[i + 1] ?? "")) out.push("--wait=");
    else out.push(a);
  }
  return out;
}

export function parseCli(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: normaliseWait(argv), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

/**
 * Split free text (stdin, .txt, .csv) into numbers and e-mail addresses. Text: tokens containing "@" are e-mails.
 * CSV: a `phone`/`number`/`msisdn`/`mobile`/`e164` column → numbers, an `email` column → e-mails; else the first
 * column (cells with "@" are e-mails).
 */
export function extractIdentifiers(text: string, csv = false): { numbers: string[]; emails: string[] } {
  const numbers: string[] = [], emails: string[] = [];
  const put = (v: string) => { if (v) (v.includes("@") ? emails : numbers).push(v); };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!csv) {
    lines.flatMap((l) => l.split(/[,;\t]/)).map((x) => x.trim()).forEach(put);
    return { numbers, emails };
  }
  const cells = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "").trim());
  const header = cells(lines[0] ?? "").map((h) => h.toLowerCase());
  const phoneCol = header.findIndex((h) => /^(phone|phone_number|number|msisdn|mobile|e164)$/.test(h));
  const emailCol = header.findIndex((h) => /^(email|e-mail|email_address|mail)$/.test(h));
  if (phoneCol >= 0 || emailCol >= 0) {
    for (const l of lines.slice(1)) {
      const c = cells(l);
      if (phoneCol >= 0 && c[phoneCol]) numbers.push(c[phoneCol]!);
      if (emailCol >= 0 && c[emailCol]) emails.push(c[emailCol]!);
    }
    return { numbers, emails };
  }
  const hasHeader = !/\d{4}|@/.test(lines[0] ?? "");
  for (const l of lines.slice(hasHeader ? 1 : 0)) put(cells(l)[0] ?? "");
  return { numbers, emails };
}

/** Split free text (stdin, .txt, .csv) into number strings. CSV: `phone`/`number`/`msisdn`/`mobile` column or first column. */
export function extractNumbers(text: string, csv = false): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!csv) return lines.flatMap((l) => l.split(/[,;\t]/)).map((s) => s.trim()).filter(Boolean);
  const cells = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "").trim());
  const header = cells(lines[0] ?? "").map((h) => h.toLowerCase());
  const named = header.findIndex((h) => /^(phone|phone_number|number|msisdn|mobile|e164)$/.test(h));
  const hasHeader = named >= 0 || !/\d{4}/.test(lines[0] ?? "");
  const col = named >= 0 ? named : 0;
  return lines.slice(hasHeader ? 1 : 0).map((l) => cells(l)[col] ?? "").filter(Boolean);
}

function intArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(v);
}

function ago(iso: string | null): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "-";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type Paint = (cell: string, padded: string, header: boolean) => string;
const ANSI = { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
/** Colour verdicts in TTY tables (widths are computed on the plain text). */
export const paintVerdict: Paint = (cell, padded, header) => {
  if (header) return ANSI.bold + padded + ANSI.reset;
  const c = cell.toLowerCase();
  let color = "";
  if (c === "not registered" || c === "high" || c === "failed" || c.startsWith("invalid_")) color = ANSI.red;
  else if (c.startsWith("registered") || c === "valid") color = ANSI.green;
  else if (["unknown", "pending", "unsupported_country", "medium", "duplicate", "suppressed"].includes(c)) color = ANSI.yellow;
  else if (c === "-") color = ANSI.dim;
  return color ? color + padded + ANSI.reset : padded;
};

function table(rows: string[][], paint?: Paint): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r, ri) => r.map((c, i) => {
    const padded = i === r.length - 1 ? c : c.padEnd(widths[i]!);
    return paint ? paint(c, padded, ri === 0) : padded;
  }).join("  ").trimEnd()).join("\n") + "\n";
}

/** Verdict for one service's answer. */
function checkVerdict(c: CheckResult | undefined): string {
  if (!c) return "-";
  // attributes services (carrier, …) answer data: registered is true ("data found") or, from older servers, null
  if (c.status === "completed" && c.attributes && Object.keys(c.attributes).some((k) => k !== "business")) {
    const a = c.attributes;
    return [a.carrier, a.line_type].filter((x) => typeof x === "string").join(" / ") || "data";
  }
  if (c.registered === true) return c.attributes?.business === true ? "registered (business)" : "registered";
  if (c.registered === false) return "not registered";
  return c.status === "completed" ? "unknown" : String(c.status);
}

/** Per-service results of an item; falls back to the v1 `whatsapp` object for older responses. */
function checksOf(item: ResultItem): Record<string, CheckResult> {
  if (item.checks) return item.checks as Record<string, CheckResult>;
  if (item.whatsapp) return { [String(item.whatsapp.service)]: { attributes: item.whatsapp.business != null ? { business: item.whatsapp.business } : null, ...item.whatsapp } as CheckResult };
  return {};
}

function columnLabel(code: string): string {
  const [ns, kind] = code.split(".");
  return (kind === "registered" || !kind ? ns! : code).toUpperCase();
}

type Column = { label: string; cell: (c: CheckResult | undefined) => string };
/** Not-conclusive answers show their status (unknown, pending, unsupported_country…) in the first column of a service. */
const statusOr = (c: CheckResult | undefined, f: (c: CheckResult) => string) =>
  !c ? "" : c.status === "completed" && c.attributes ? f(c) : c.status === "completed" ? "unknown" : String(c.status);
/** Table columns per service: number.spam gets SPAM RISK + SPAM SCORE; every other service one verdict column. */
function serviceColumns(code: string, single: boolean): Column[] {
  if (code === "number.spam") {
    return [
      { label: "SPAM RISK", cell: (c) => statusOr(c, (x) => String(x.attributes!.risk_level ?? "unknown")) },
      { label: "SPAM SCORE", cell: (c) => (c?.status === "completed" && typeof c.attributes?.risk_score === "number" ? String(c.attributes.risk_score) : c ? "-" : "") },
    ];
  }
  return [{ label: single && code.startsWith("whatsapp.") ? "WHATSAPP" : columnLabel(code), cell: (c) => (c ? checkVerdict(c) : "") }];
}

const isEmailRow = (r: ResultItem) => r.kind === "email";
/** Row status: number_status for phone rows, email_status for e-mail rows. */
const rowStatus = (r: ResultItem) => String((isEmailRow(r) ? r.email_status : r.number_status) ?? "valid");

function itemRows(items: ResultItem[]): string[][] {
  const services: string[] = [];
  for (const it of items) for (const k of Object.keys(checksOf(it))) if (!services.includes(k)) services.push(k);
  if (services.length === 0) services.push(items.length && items.every(isEmailRow) ? "email.valid" : "whatsapp.registered");
  const single = services.length === 1;
  const first = items.length && items.every(isEmailRow) ? "EMAIL" : items.some(isEmailRow) ? "INPUT" : "NUMBER";
  const cols = services.map((s) => ({ s, cols: serviceColumns(s, single) }));
  const header = [first, ...cols.flatMap((x) => x.cols.map((c) => c.label)), "CONFIDENCE", "CHECKED", "CACHED", "BILLED"];
  return [
    header,
    ...items.map((r) => {
      const cs = checksOf(r);
      const list = services.map((s) => cs[s]);
      const valid = rowStatus(r) === "valid";
      const first = list.find(Boolean);
      return [
        (isEmailRow(r) ? r.email : r.e164) ?? r.input,
        ...cols.flatMap((x) => x.cols.map((c, i) => (!valid ? (i === 0 ? rowStatus(r) : "") : c.cell(cs[x.s])))),
        first?.confidence ?? "-",
        ago(first?.checked_at ?? null),
        first ? (list.every((c) => !c || c.cached) ? "yes" : "no") : "-",
        first ? (list.some((c) => c?.billed) ? "yes" : "no") : "-",
      ];
    }),
  ];
}

function isConclusive(item: ResultItem): boolean {
  if (rowStatus(item) !== "valid") return false;
  const cs = Object.values(checksOf(item));
  return cs.length > 0 && cs.every((c) => c.status === "completed" && (typeof c.registered === "boolean" || !!c.attributes));
}

function servicesTable(list: Service[], paint?: Paint): string {
  return table([
    ["CODE", "PLATFORM", "INPUT", "RESULT", "REAL TIME", "PRICE (RT / BULK)", "ATTRIBUTES", "COUNTRIES"],
    ...list.map((s) => [
      s.code + (s.beta ? " (beta)" : ""), s.platform, s.input_type === "email" ? "e-mail" : "phone", String(s.result_kind),
      s.realtime ? "yes" : "bulk only",
      `${s.prices.realtime ? "$" + s.prices.realtime.amount : "-"} / $${s.prices.batch.amount}`,
      s.attributes.map((a) => a.key).join(",") || "-", s.countries.join(",") || "all",
    ]),
  ], paint ? (_c, p, h) => (h ? paint(_c, p, h) : p) : undefined);
}

/** Error block: code + message, then the API's suggestion, docs link and request id on their own lines. */
export function formatError(err: MobileValidateError): string {
  let s = `Error: ${err.code}: ${err.message}\n`;
  if (err.suggestion) s += `  Suggestion: ${err.suggestion}\n`;
  else if (err.code === "missing_api_key") s += "  Suggestion: set MOBILEVALIDATE_API_KEY, or add --sandbox to try the test values.\n";
  else if (err.code === "connection_error" || err.code === "timeout") s += "  Suggestion: check your network and --base-url; the SDK already retried.\n";
  if (err.docUrl) s += `  Docs: ${err.docUrl}\n`;
  if (err.requestId) s += `  Request ID: ${err.requestId}\n`;
  if (err.retryable && err.retryAfterMs) s += `  Retry after: ${Math.ceil(err.retryAfterMs / 1000)} s\n`;
  return s;
}

function printError(io: CliIO, err: MobileValidateError): number {
  io.stderr(formatError(err));
  return EXIT.ERROR;
}

/** Row hints (invalid or likely-mistyped input) printed under a table. */
function printHints(io: CliIO, items: ResultItem[]) {
  const hints = items.filter((r) => typeof r.suggestion === "string" && r.suggestion);
  if (!hints.length) return;
  io.stdout("\nHints:\n");
  for (const r of hints) io.stdout(`  ${r.input}: ${r.suggestion}\n`);
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`Error: ${e.message}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    if (e instanceof MobileValidateError) return printError(io, e);
    io.stderr(`Error: ${(e as Error)?.message ?? String(e)}\n`);
    return EXIT.ERROR;
  }
}

async function dispatch(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals: pos } = parseCli(argv);
  if (v.version) { io.stdout(`${VERSION}\n`); return EXIT.OK; }
  const [cmd, ...rest] = pos;
  if (v.help || !cmd) { (cmd || v.help ? io.stdout : io.stderr)(USAGE); return v.help ? EXIT.OK : EXIT.USAGE; }

  const json = v.json ?? false;
  const pretty = io.isTTY && !json;
  const out = (o: unknown) => io.stdout(JSON.stringify(o, null, io.isTTY ? 2 : 0) + "\n");

  // Local commands: no API key needed.
  if ((cmd === "webhooks" || cmd === "webhook") && (rest[0] === "verify" || rest[0] === "sign")) {
    return webhookLocal(rest[0], v, io, { pretty, json, out });
  }

  const apiKey = v["api-key"] ?? (v.sandbox ? SANDBOX_PUBLIC_KEY : io.env.MOBILEVALIDATE_API_KEY);
  if (!apiKey) {
    throw new UsageError("No API key. Set MOBILEVALIDATE_API_KEY (get a test key: https://mobilevalidate.com/get-test-key), "
      + "or add --sandbox to try the test values without signing up.");
  }
  if (apiKey === SANDBOX_PUBLIC_KEY && pretty) {
    io.stderr("Using the public sandbox key: only test values work (mobilevalidate.com/docs/test-values).\n");
  }
  const opts: MobileValidateOptions = {
    apiKey,
    baseUrl: v["base-url"] ?? io.env.MOBILEVALIDATE_BASE_URL ?? undefined,
  };
  const mv = io.createClient ? io.createClient(opts) : new MobileValidate(opts);
  const paint = pretty && !v["no-color"] && !io.env.NO_COLOR ? paintVerdict : undefined;
  const checks = v.checks?.split(",").map((s) => s.trim()).filter(Boolean);
  const country = v.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new UsageError("--country must be an ISO 3166-1 alpha-2 code like GB");

  switch (cmd) {
    case "check": {
      let args = rest;
      if (args.includes("-")) {
        const fromStdin = extractIdentifiers(await io.readStdin());
        args = [...args.filter((n) => n !== "-"), ...fromStdin.numbers, ...fromStdin.emails];
      }
      const numbers = args.filter((a) => !a.includes("@"));
      const emails = args.filter((a) => a.includes("@"));
      if (args.length === 0) throw new UsageError("check needs at least one number or e-mail address (or - for stdin)");
      if (args.length > LOOKUP_MAX) throw new UsageError(`check accepts up to ${LOOKUP_MAX} numbers and e-mails; use "jobs create --file" for more`);
      const waitS = intArg(v.wait, "wait") ?? 60;
      // Default checks per input kind: whatsapp for numbers, email for addresses.
      const effective = checks ?? [...(numbers.length ? ["whatsapp"] : []), ...(emails.length ? ["email"] : [])];
      const { data, error } = await mv.lookup({
        numbers: numbers.length ? numbers : undefined, emails: emails.length ? emails : undefined,
        checks: effective, defaultCountry: country,
        maxAge: v["max-age"], maxCost: v["max-cost"],
        wait: Math.min(30, waitS), waitTimeoutMs: waitS * 1000,
      });
      if (error) return printError(io, error);
      printLookup(io, data, { pretty, json, out, paint });
      return data.status === "completed" && data.results.every(isConclusive) ? EXIT.OK : EXIT.PARTIAL;
    }
    case "check-email": {
      let emails = rest;
      if (emails.includes("-")) emails = [...emails.filter((n) => n !== "-"), ...extractIdentifiers(await io.readStdin()).emails];
      if (emails.length === 0) throw new UsageError("check-email needs at least one e-mail address (or - for stdin)");
      if (emails.length > LOOKUP_MAX) throw new UsageError(`check-email accepts up to ${LOOKUP_MAX} addresses; use "job create --file" for more`);
      const waitS = intArg(v.wait, "wait") ?? 60;
      const emailChecks = checks ?? ["email"];
      const { data, error } = await mv.lookup({
        emails, checks: emailChecks, maxAge: v["max-age"], maxCost: v["max-cost"],
        wait: Math.min(30, waitS), waitTimeoutMs: waitS * 1000,
      });
      if (!error) {
        printLookup(io, data, { pretty, json, out, paint });
        return data.status === "completed" && data.results.every(isConclusive) ? EXIT.OK : EXIT.PARTIAL;
      }
      // Bulk-only e-mail checks (e.g. gmail): run the same request as a job and wait for it.
      if (error.code !== "service_disabled" || !/bulk jobs only/i.test(error.message)) return printError(io, error);
      return emailJob(mv, io, { emails, checks: emailChecks, maxAge: v["max-age"], maxCost: v["max-cost"], waitS }, { pretty, json, out, paint });
    }
    case "lookup": {
      const id = rest[0];
      if (!id) throw new UsageError("lookup needs a lookup id");
      const { data, error } = await mv.lookups.get(id, { wait: intArg(v.wait, "wait") });
      if (error) return printError(io, error);
      printLookup(io, data, { pretty, json, out, paint });
      return data.status === "completed" && data.results.every(isConclusive) ? EXIT.OK : EXIT.PARTIAL;
    }
    case "services": {
      const { data, error } = await mv.services();
      if (error) return printError(io, error);
      if (json) out(data);
      else if (pretty) io.stdout(servicesTable(data.data ?? [], paint) + "\nPlatform names are used descriptively only; no affiliation.\n");
      else for (const s of data.data ?? []) io.stdout(JSON.stringify(s) + "\n");
      return EXIT.OK;
    }
    case "job":
    case "jobs":
      return jobCommand(mv, rest, v, io, { pretty, json, out, paint, checks, country });
    case "webhooks":
    case "webhook":
      return webhookRemote(mv, rest, io, { pretty, json, out, paint });
    case "account":
    case "limits": {
      const { data, error } = cmd === "account" ? await mv.account.get() : await mv.limits.get();
      if (error) return printError(io, error);
      if (pretty) io.stdout(kv(data as Record<string, unknown>));
      else out(data);
      return EXIT.OK;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}"`);
  }
}

type Out = { pretty: boolean; json: boolean; out: (o: unknown) => void; paint?: Paint };

const TERMINAL_JOB = new Set(["completed", "failed", "cancelled"]);

/** check-email fallback: create a job, long-poll it within the wait budget, then print its rows like a lookup. */
async function emailJob(mv: MobileValidate, io: CliIO,
  p: { emails: string[]; checks: string[]; maxAge?: string; maxCost?: string; waitS: number }, o: Out): Promise<number> {
  const created = await mv.jobs.create({ emails: p.emails, checks: p.checks, maxAge: p.maxAge, maxCost: p.maxCost });
  if (created.error) return printError(io, created.error);
  let job = created.data;
  if (o.pretty) io.stderr(`Some checks are bulk only; running job ${job.id}…\n`);
  const deadline = Date.now() + p.waitS * 1000;
  while (!TERMINAL_JOB.has(String(job.status))) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (left < 1) break;
    const next = await mv.jobs.get(job.id, { wait: Math.min(30, left) });
    if (next.error) return printError(io, next.error);
    job = next.data;
  }
  if (!TERMINAL_JOB.has(String(job.status))) {
    if (o.pretty) io.stdout(`Job ${job.id} is still ${job.status}. Follow it: mobilevalidate jobs get ${job.id} --wait 30\n`);
    else o.out(job);
    return EXIT.PARTIAL;
  }
  const items: ResultItem[] = [];
  for await (const item of mv.jobs.results(job.id, { limit: 1000 })) items.push(item);
  if (o.json) o.out({ job, results: items });
  else if (o.pretty) io.stdout(items.length ? table(itemRows(items), o.paint) : "No results.\n");
  else for (const r of items) io.stdout(JSON.stringify(r) + "\n");
  return job.status === "completed" && items.every(isConclusive) ? EXIT.OK : EXIT.PARTIAL;
}

function printLookup(io: CliIO, data: Lookup, o: Out) {
  if (o.json) return o.out(data);
  if (!o.pretty) {
    for (const r of data.results) io.stdout(JSON.stringify(r) + "\n");
    return;
  }
  io.stdout(table(itemRows(data.results), o.paint));
  printHints(io, data.results);
  const s = data.summary;
  const cost = data.billing ? `  cost $${data.billing.cost.amount}` : "";
  const by = Object.entries(s.by_service ?? {});
  if (by.length > 1) {
    const noun = data.results.every(isEmailRow) ? "e-mails" : data.results.some(isEmailRow) ? "rows" : "numbers";
    io.stdout(`\n${s.total} ${noun}, ${s.invalid} invalid${cost}\n`);
    for (const [code, c] of by) {
      if (c) io.stdout(`${columnLabel(code)}: ${c.registered} registered, ${c.not_registered} not registered, ${c.unknown} unknown, ${c.pending} pending\n`);
    }
  } else {
    io.stdout(`\n${s.registered} registered, ${s.not_registered} not registered, ${s.unknown} unknown, ${s.pending} pending, ${s.invalid} invalid${cost}\n`);
  }
  if (data.status === "pending") io.stdout(`Still pending. Re-check later: mobilevalidate lookup ${data.id}\n`);
}

function kv(obj: Record<string, unknown>, indent = ""): string {
  let s = "";
  for (const [k, val] of Object.entries(obj)) {
    if (val && typeof val === "object" && "amount" in val && "currency" in val) {
      s += `${indent}${k}: ${(val as { amount: string }).amount} ${(val as { currency: string }).currency}\n`;
    } else if (val && typeof val === "object") {
      s += `${indent}${k}:\n${kv(val as Record<string, unknown>, indent + "  ")}`;
    } else {
      s += `${indent}${k}: ${String(val)}\n`;
    }
  }
  return s;
}

function printJob(io: CliIO, job: Job, o: Out) {
  if (!o.pretty) return o.out(job);
  const p = job.progress;
  const unit = p && p.checks_total && p.checks_total !== p.total ? ` checks (${p.total} rows)` : "";
  io.stdout(`${job.id}  ${job.status}${p ? `  ${p.done}/${p.checks_total ?? p.total} done${unit}` : ""}${job.eta_seconds ? `  eta ${job.eta_seconds}s` : ""}\n`);
  if (job.cost) io.stdout(`cost: charged $${job.cost.charged.amount}, reserved $${job.cost.reserved.amount}, max $${job.cost.estimated_max.amount}\n`);
}

async function jobCommand(
  mv: MobileValidate, args: string[], v: ParsedCli["values"], io: CliIO,
  o: Out & { checks?: string[]; country?: string },
): Promise<number> {
  const [sub, id] = args;
  if (sub === "create") {
    const file = v.file ?? (id === "-" ? "-" : undefined);
    if (!file) throw new UsageError("job create needs --file <path> (.txt or .csv, or - for stdin)");
    const text = file === "-" ? await io.readStdin() : await io.readFile(file);
    const { numbers, emails } = extractIdentifiers(text, /\.csv$/i.test(file));
    if (numbers.length + emails.length === 0) throw new UsageError("no numbers or e-mail addresses found in input");
    if (numbers.length + emails.length > JOB_JSON_MAX) throw new UsageError(`at most ${JOB_JSON_MAX} numbers and e-mails per job from the CLI`);
    const { data, error } = await mv.jobs.create({
      numbers: numbers.length ? numbers : undefined, emails: emails.length ? emails : undefined, checks: o.checks, defaultCountry: o.country, maxAge: v["max-age"], maxCost: v["max-cost"],
    });
    if (error) return printError(io, error);
    if (v.wait === undefined) {
      printJob(io, data, o);
      if (o.pretty) io.stdout(`Follow progress: mobilevalidate jobs get ${data.id} --wait 30\n`);
      return EXIT.OK;
    }
    // --wait [s]: wait for the job (default budget 600 s), then print its results like a lookup.
    const budgetS = intArg(v.wait, "wait") ?? 600;
    if (o.pretty) io.stderr(`Job ${data.id} created (${numbers.length + emails.length} rows); waiting up to ${budgetS} s…\n`);
    const waited = await mv.jobs.wait(data.id, { timeoutMs: budgetS * 1000 });
    if (waited.error) return printError(io, waited.error);
    const job = waited.data;
    if (!TERMINAL_JOB.has(String(job.status))) {
      if (o.pretty) { printJob(io, job, o); io.stdout(`Still ${job.status}. Follow it: mobilevalidate jobs get ${job.id} --wait 30\n`); }
      else o.out(job);
      return EXIT.PARTIAL;
    }
    if (job.status !== "completed") {
      if (o.pretty) printJob(io, job, o); else o.out(job);
      return EXIT.ERROR;
    }
    const items: ResultItem[] = [];
    for await (const item of mv.jobs.results(job.id, { limit: 1000 })) items.push(item);
    if (o.json) o.out({ job, results: items });
    else if (o.pretty) {
      printJob(io, job, o);
      io.stdout("\n" + (items.length ? table(itemRows(items), o.paint) : "No results.\n"));
      printHints(io, items);
    } else for (const r of items) io.stdout(JSON.stringify(r) + "\n");
    return items.every(isConclusive) ? EXIT.OK : EXIT.PARTIAL;
  }
  if (sub && !["get", "cancel", "results", "download"].includes(sub)) throw new UsageError(`Unknown job subcommand "${sub}"`);
  if (!id) throw new UsageError(`job ${sub ?? "<get|results|download|cancel>"} needs a job id`);
  if (sub === "get") {
    const { data, error } = await mv.jobs.get(id, { wait: intArg(v.wait, "wait") });
    if (error) return printError(io, error);
    printJob(io, data, o);
    return data.status === "failed" ? EXIT.ERROR : EXIT.OK;
  }
  if (sub === "download") {
    const format = v.format ?? "csv";
    if (format !== "csv" && format !== "ndjson") throw new UsageError("--format must be csv or ndjson");
    const { data, error } = await mv.jobs.download(id, { format });
    if (error) return printError(io, error);
    if (v.output) {
      if (!io.writeFile) throw new UsageError("--output is not available here; redirect stdout instead");
      await io.writeFile(v.output, data.body);
      if (o.pretty) io.stdout(`Saved ${format.toUpperCase()} results of ${id} to ${v.output}\n`);
      return EXIT.OK;
    }
    const reader = data.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      io.stdout(dec.decode(value, { stream: true }));
    }
    const tail = dec.decode();
    if (tail) io.stdout(tail);
    return EXIT.OK;
  }
  if (sub === "cancel") {
    const { data, error } = await mv.jobs.cancel(id);
    if (error) return printError(io, error);
    printJob(io, data, o);
    return EXIT.OK;
  }
  if (sub === "results") {
    const reg = v.registered;
    if (reg !== undefined && !["true", "false", "null"].includes(reg)) throw new UsageError("--registered must be true, false or null");
    const limit = intArg(v.limit, "limit");
    const items: ResultItem[] = [];
    let count = 0;
    for await (const item of mv.jobs.results(id, { registered: reg as "true" | "false" | "null" | undefined, limit: Math.min(limit ?? 1000, 1000) })) {
      if (o.pretty || o.json) items.push(item);
      else io.stdout(JSON.stringify(item) + "\n");
      if (limit !== undefined && ++count >= limit) break;
    }
    if (o.json) o.out(items);
    else if (o.pretty) io.stdout(items.length ? table(itemRows(items), o.paint) : "No results.\n");
    return EXIT.OK;
  }
  throw new UsageError(`Unknown job subcommand "${sub ?? ""}"`);
}

/** Parse raw HTTP header lines ("Name: value") into a record (lower-cased names). */
export function parseHeaderLines(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

/** `webhooks verify` / `webhooks sign`: local only, never calls the API. */
async function webhookLocal(sub: "verify" | "sign", v: ParsedCli["values"], io: CliIO, o: Out): Promise<number> {
  const secret = v.secret ?? io.env.MOBILEVALIDATE_WEBHOOK_SECRET;
  if (!secret) throw new UsageError(`webhooks ${sub} needs --secret or env MOBILEVALIDATE_WEBHOOK_SECRET (the endpoint's whsec_… secret)`);
  if (!v.file) throw new UsageError(`webhooks ${sub} needs --file <raw body file|-> (the exact bytes received)`);
  const raw = v.file === "-" ? await io.readStdin() : await io.readFile(v.file);
  const now = io.now ? io.now() : Math.floor(Date.now() / 1000);
  if (sub === "sign") {
    const id = v.id ?? `msg_${now.toString(36)}`;
    const ts = v.timestamp ?? String(now);
    const sig = await signWebhook(secret, id, ts, raw);
    const headers = { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig };
    if (o.json) o.out(headers);
    else for (const [k, val] of Object.entries(headers)) io.stdout(`${k}: ${val}\n`);
    return EXIT.OK;
  }
  const fromFile = v.headers ? parseHeaderLines(await io.readFile(v.headers)) : {};
  const headers: Record<string, string | undefined> = {
    "webhook-id": v.id ?? fromFile["webhook-id"],
    "webhook-timestamp": v.timestamp ?? fromFile["webhook-timestamp"],
    "webhook-signature": v.signature ?? fromFile["webhook-signature"],
  };
  const tolerance = intArg(v.tolerance, "tolerance");
  try {
    const event = await verifyWebhook(raw, headers, secret, { now, toleranceSeconds: tolerance });
    if (o.json) o.out({ valid: true, type: event.type, id: event.id });
    else io.stdout(`Signature valid. Event ${String(event.type)} (${String(event.id)})\n`);
    return EXIT.OK;
  } catch (e) {
    if (!(e instanceof WebhookVerificationError)) throw e;
    if (o.json) o.out({ valid: false, reason: e.message });
    io.stderr(`Signature INVALID: ${e.message}\n`
      + "  Suggestion: pass the raw body exactly as received (not re-serialized JSON), the endpoint's own whsec_ secret, "
      + "and use --tolerance <s> for captured events older than 5 minutes.\n");
    return EXIT.ERROR;
  }
}

/** `webhooks list` / `webhooks test <endpoint_id>`. */
async function webhookRemote(mv: MobileValidate, args: string[], io: CliIO, o: Out): Promise<number> {
  const [sub, id] = args;
  if (sub === "list") {
    const { data, error } = await mv.webhookEndpoints.list();
    if (error) return printError(io, error);
    if (!o.pretty) return (o.out(data), EXIT.OK);
    const list = data.data ?? [];
    io.stdout(list.length ? table([["ID", "URL", "EVENTS", "STATUS"], ...list.map((e) => [e.id, e.url, e.events.join(","), String(e.status ?? "-")])], o.paint) : "No webhook endpoints.\n");
    return EXIT.OK;
  }
  if (sub === "test") {
    if (!id) throw new UsageError("webhooks test needs an endpoint id (see: mobilevalidate webhooks list)");
    const { data, error } = await mv.webhookEndpoints.test(id);
    if (error) return printError(io, error);
    if (o.pretty) io.stdout(`Test event queued for ${id}.\n`);
    else o.out(data);
    return EXIT.OK;
  }
  throw new UsageError(`Unknown webhooks subcommand "${sub ?? ""}" (verify, sign, list, test)`);
}
