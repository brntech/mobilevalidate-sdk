import type { MobileValidateError } from "./errors.ts";
import type { CheckInput, ServiceCode } from "./services.generated.ts";

/**
 * Public API v1 types. Enums are open (`| (string & {})`) and objects may carry extra fields:
 * the API only makes additive changes within /v1, so clients must tolerate unknown values.
 */
type Open<T extends string> = T | (string & {});

/**
 * Every SDK method resolves to a Result: `data` on success, `error` (a MobileValidateError subclass) on failure — never
 * both. `requestId` is the API's `x-request-id` (null only when no response was received); quote it to support.
 */
export type Result<T> =
  | { data: T; error: null; requestId: string | null }
  | { data: null; error: MobileValidateError; requestId: string | null };

export interface Money {
  /** Decimal string, e.g. "0.0012". Never a float. */
  amount: string;
  currency: Open<"USD">;
}

export type CheckStatus = Open<"completed" | "pending" | "unknown" | "unsupported_country" | "failed">;
export type NumberStatus = Open<"valid" | "invalid_number" | "duplicate" | "suppressed">;
/** Status of an e-mail row. */
export type EmailStatus = Open<"valid" | "invalid_email" | "duplicate" | "suppressed">;
/** Input type of a result row. */
export type InputKind = Open<"phone" | "email">;

export interface WhatsAppResult {
  service: Open<"whatsapp.registered" | "whatsapp.business">;
  status: CheckStatus;
  /** true / false (conclusive) / null (unknown — never billed). */
  registered: boolean | null;
  business?: boolean | null;
  confidence: Open<"high" | "medium" | "low"> | null;
  confidence_score: number | null;
  checked_at: string | null;
  cached: boolean;
  age_seconds: number | null;
  billed: boolean;
  reason: string | null;
  poll_after_ms: number | null;
  [extra: string]: unknown;
}

/** One service's answer for one number or e-mail address. */
export interface CheckResult {
  service: ServiceCode;
  status: CheckStatus;
  /**
   * Boolean services: true / false (conclusive) / null (unknown — never billed). Attributes services (carrier, spam):
   * true when data was found (conclusive), else null.
   */
  registered: boolean | null;
  /**
   * Whitelisted, service-defined attributes (e.g. `business`, `carrier`, `line_type`, `risk_level`); values are strings,
   * booleans or integers (e.g. `risk_score`). null when none or not conclusive. See `SpamAttributes` for number.spam.
   */
  attributes: Record<string, string | boolean | number> | null;
  confidence: Open<"high" | "medium" | "low"> | null;
  confidence_score: number | null;
  checked_at: string | null;
  cached: boolean;
  age_seconds: number | null;
  billed: boolean;
  reason: string | null;
  poll_after_ms: number | null;
  [extra: string]: unknown;
}

/**
 * One result row. Phone rows (`kind: "phone"`, or no `kind` from older servers) carry `e164`, `country`,
 * `number_status`. E-mail rows (`kind: "email"`) carry `email` (normalized, null if invalid) and `email_status`;
 * their `e164` / `country` are null. Rows are ordered numbers first, then e-mails.
 */
export interface ResultItem {
  kind?: InputKind;
  /** As sent in the originating request; masked on later reads. */
  input: string;
  e164: string | null;
  country: string | null;
  /** Phone rows only. */
  number_status?: NumberStatus;
  /** E-mail rows only: normalized address (null when invalid). */
  email?: string | null;
  /** E-mail rows only. */
  email_status?: EmailStatus;
  /** One entry per requested service of the row's kind, keyed by service code. Absent for invalid / duplicate / suppressed rows. */
  checks?: Partial<Record<ServiceCode, CheckResult>>;
  /** v1 shape: mirrors checks["whatsapp.business"] if requested, else checks["whatsapp.registered"]. */
  whatsapp?: WhatsAppResult;
  test?: boolean;
  /** Invalid or likely-mistyped input: a plain-English hint, e.g. a missing country code. */
  suggestion?: string;
  [extra: string]: unknown;
}

export interface ServiceCounts {
  completed: number;
  /** For data services (e.g. carrier): data found. */
  registered: number;
  not_registered: number;
  unknown: number;
  pending: number;
}

/**
 * Top-level counts are per row (numbers and e-mails) for the row's primary service (first requested check of its
 * kind); `invalid` includes invalid e-mails. `by_service` per service.
 */
export interface Summary {
  total: number;
  registered: number;
  not_registered: number;
  unknown: number;
  pending: number;
  invalid: number;
  suppressed: number;
  by_service?: Partial<Record<ServiceCode, ServiceCounts>>;
  [extra: string]: unknown;
}

export interface Lookup {
  object: "lookup";
  id: string;
  status: Open<"completed" | "pending">;
  livemode: boolean;
  created_at: string;
  results: ResultItem[];
  summary: Summary;
  billing?: { billed_units: number; cost: Money; balance_after: Money; [extra: string]: unknown };
  next?: { poll_url: string; poll_after_ms: number } | null;
  metadata?: Record<string, string>;
  request_id: string;
  [extra: string]: unknown;
}

export interface Estimate {
  total?: number;
  valid?: number;
  invalid?: number;
  duplicate?: number;
  cached?: number;
  unsupported?: number;
  suppressed?: number;
  billable_max?: number;
  max_cost?: Money;
  checks?: ServiceCode[];
  /** Σ rows × services of the row's kind */
  checks_total?: number;
  [extra: string]: unknown;
}

export type JobStatus = Open<"queued" | "preflight" | "running" | "merging" | "completed" | "failed" | "cancelled">;

export interface Job {
  object: "job";
  id: string;
  status: JobStatus;
  created_at: string;
  checks?: ServiceCode[];
  /** total = rows (numbers + e-mails); checks_total = Σ rows × services of their kind; done / conclusive / non_billable count checks. */
  progress?: { total: number; checks_total?: number; done: number; conclusive: number; non_billable: number };
  eta_seconds?: number | null;
  cost?: { estimated_max: Money; reserved: Money; charged: Money; released: Money };
  estimate?: Estimate;
  retention_days?: number;
  metadata?: Record<string, string>;
  [extra: string]: unknown;
}

/** File format of `GET /v1/jobs/{id}/download`. */
export type DownloadFormat = "csv" | "ndjson";

/** One NDJSON download line: the CSV columns as keys (`row_no`, `input_masked`, `e164`, …, `<service>.<field>`). */
export type DownloadRow = Record<string, string | number | boolean | null>;

interface JobDownloadBase<F extends DownloadFormat> {
  format: F;
  /** Response Content-Type, e.g. `text/csv; charset=utf-8` or `application/x-ndjson`. */
  contentType: string | null;
  /** File name suggested by the API (Content-Disposition), e.g. `job_….csv`. */
  filename: string | null;
  /** The file as a byte stream (read it once: `body`, `text()` or `rows()`). */
  body: ReadableStream<Uint8Array>;
  /** Read the whole file as a string. */
  text(): Promise<string>;
}

/** A streamed job result file. NDJSON downloads can also be iterated line by line with `rows()`. */
export type JobDownload<F extends DownloadFormat = DownloadFormat> = F extends "ndjson"
  ? JobDownloadBase<"ndjson"> & { rows(): AsyncGenerator<DownloadRow, void, undefined> }
  : JobDownloadBase<F>;

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string | null;
}

export interface Account {
  org_id: string;
  balance: Money;
  reserved: Money;
  today?: Record<string, unknown>;
  [extra: string]: unknown;
}

export type WebhookEventType = Open<
  "lookup.completed" | "job.completed" | "job.failed" | "job.progress" | "balance.low" | "limits.cap_reached"
>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  [extra: string]: unknown;
}

export interface WebhookEvent<T = Record<string, unknown>> {
  type: WebhookEventType;
  id: string;
  created_at: string;
  data: T;
  [extra: string]: unknown;
}

/** Money input: decimal string ("0.05"), number (0.05) or a Money object. */
export type MoneyInput = string | number | Money;

/** Seconds, or a duration string like "30s", "15m", "24h", "7d". */
export type DurationInput = number | string;

/** A catalog entry from GET /v1/services. */
export interface Service {
  object: "service";
  code: ServiceCode;
  name: string;
  /** Platform name, used descriptively only. */
  platform: string;
  family: Open<"messaging" | "social" | "apps" | "network" | "email" | "finance">;
  description?: string;
  input_type: Open<"phone" | "email">;
  result_kind: Open<"boolean" | "attributes">;
  attributes: {
    key: string;
    type: Open<"string" | "boolean" | "enum" | "integer">;
    /** Allowed values (type "enum"). */
    values?: string[];
    /** Inclusive bounds (type "integer"). */
    min?: number | null;
    max?: number | null;
    description: string;
  }[];
  /** Usable with `lookup()`; otherwise bulk jobs only. */
  realtime: boolean;
  batch: boolean;
  status: Open<"active" | "unavailable">;
  beta: boolean;
  /** ISO alpha-2; empty = all countries. */
  countries: string[];
  prices: { realtime: Money | null; batch: Money };
  [extra: string]: unknown;
}

/** Options accepted by every method. */
export interface CallOptions {
  signal?: AbortSignal;
  /** Override the client's per-request timeout for this call (ms). */
  timeoutMs?: number;
  /** Override the client's retry count for this call. */
  maxRetries?: number;
}

export interface CheckOptions extends CallOptions {
  /**
   * Service codes or aliases (e.g. "whatsapp", "telegram", "viber", "carrier"; e-mail: "email", "gmail", …).
   * Default ["whatsapp"]. Phone services apply to numbers, e-mail services to e-mails. At most 20 checks; identifiers ×
   * applicable checks ≤ 2,000 per lookup (else `invalid_request`, param `checks`).
   */
  checks?: CheckInput[];
  /** ISO 3166-1 alpha-2 country used for national-format numbers. */
  defaultCountry?: string;
  /** Accept cached results up to this age. 0 forces a fresh (billed) check. */
  maxAge?: DurationInput;
  /** Seconds the server waits on the first request (0–30, default 10). 0 also disables client polling. */
  wait?: number;
  /** Overall budget for waiting/polling in ms (default: client `waitTimeoutMs`, 60 s). */
  waitTimeoutMs?: number;
  /** Refuse (402 cost_limit_exceeded) if the maximum possible cost is higher. */
  maxCost?: MoneyInput;
  metadata?: Record<string, string>;
  webhookEndpointId?: string;
  idempotencyKey?: string;
}

/** `lookup({ numbers?, emails?, checks })`: numbers and/or e-mail addresses, ≤ 100 in total. */
export interface LookupParams extends CheckOptions {
  numbers?: string[];
  /**
   * E-mail addresses, checked by e-mail services (e.g. "email", "gmail"). Answers are yes/no/unknown only —
   * never names or profiles. ≥ 20 addresses on one domain differing only by digits are refused (suspected_enumeration).
   */
  emails?: string[];
}

export interface JobCreateParams extends CallOptions {
  numbers?: string[];
  /** E-mail addresses; numbers + emails ≤ 50 000. */
  emails?: string[];
  uploadId?: string;
  /**
   * Service codes or aliases; any active service works in jobs (including bulk-only ones). At most 20 checks;
   * identifiers × applicable checks ≤ 100,000 per job (else `invalid_request`, param `checks`).
   */
  checks?: CheckInput[];
  defaultCountry?: string;
  maxAge?: DurationInput;
  maxCost?: MoneyInput;
  webhookEndpointId?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface JobResultsParams extends CallOptions {
  registered?: boolean | null | "true" | "false" | "null";
  /** Service the registered/status filters apply to (default: the job's first check). */
  service?: CheckInput;
  status?: CheckStatus;
  /** Page size (1–1000, default 100). */
  limit?: number;
  after?: string;
}

/**
 * `attributes` of a conclusive `number.spam` answer. Report-based: `no_reports` means no reports are known for
 * the number — not that it is safe. Cast with `check.attributes as SpamAttributes | null`.
 */
export interface SpamAttributes {
  risk_level: Open<"high" | "medium" | "low" | "no_reports">;
  /** Integer 0–100, higher = more reports. */
  risk_score: number;
  reason_regulator?: boolean;
  reason_government?: boolean;
  reason_community?: boolean;
  reason_unassigned?: boolean;
  /** Hint only (VoIP carrier range); adds no points. */
  voip_range?: boolean;
  top_category?: Open<"debt_relief" | "impersonation" | "robocall" | "medical" | "home_services" | "warranty" | "sms_spam" | "dialer" | "fraud_hacking" | "other">;
  /** YYYY-MM */
  first_seen?: string;
  /** YYYY-MM */
  last_seen?: string;
  /** Integer: independent signal classes. */
  sources?: number;
}
