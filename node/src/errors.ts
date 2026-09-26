/** Error codes returned by the API (docs: /docs/errors). Open union: new codes may appear. */
export type ApiErrorCode =
  | "invalid_request"
  | "too_many_numbers"
  | "test_number_only"
  | "invalid_cursor"
  | "unauthorized"
  | "insufficient_balance"
  | "cost_limit_exceeded"
  | "insufficient_scope"
  | "service_disabled"
  | "sandbox_magic_only"
  | "suspected_enumeration"
  | "not_found"
  | "idempotency_key_reused"
  | "idempotency_request_in_progress"
  | "test_key_exists"
  | "payload_too_large"
  | "rate_limited"
  | "daily_cap_reached"
  | "spend_cap_reached"
  | "internal_error"
  | "temporarily_unavailable";

/** Errors produced by the SDK itself (no usable HTTP response). */
export type ClientErrorCode = "missing_api_key" | "connection_error" | "timeout" | "invalid_response" | "invalid_argument";

export type ErrorCode = ApiErrorCode | ClientErrorCode | (string & {});

/** Retryability per contract code; used when the body does not say. */
const RETRYABLE: Record<string, boolean> = {
  idempotency_request_in_progress: true,
  rate_limited: true,
  daily_cap_reached: true,
  internal_error: true,
  temporarily_unavailable: true,
  connection_error: true,
  timeout: true,
};

export interface MobileValidateErrorInit {
  code: ErrorCode;
  message: string;
  status?: number | null;
  retryable?: boolean;
  requestId?: string | null;
  param?: string | null;
  docUrl?: string | null;
  suggestion?: string | null;
  retryAfterMs?: number | null;
}

/**
 * Base class of every error the SDK returns or throws. Check `code` (stable, documented at /docs/errors) or use
 * `instanceof` with the per-code subclasses (e.g. `RateLimitedError`, `SandboxMagicOnlyError`).
 */
export class MobileValidateError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, or null when no response was received. */
  readonly status: number | null;
  /** True when retrying the same request later can succeed (the SDK already retried it `maxRetries` times). */
  readonly retryable: boolean;
  /** `x-request-id` of the failed request; quote it to support. */
  readonly requestId: string | null;
  /** The request field the error is about, e.g. "numbers" or "checks". */
  readonly param: string | null;
  /** Link to the documentation of this error code. */
  readonly docUrl: string | null;
  /** Plain-English hint on how to fix the request (e.g. "Add the country code…"), when the API has one. */
  readonly suggestion: string | null;
  /** Server hint (Retry-After) in milliseconds. */
  readonly retryAfterMs: number | null;

  constructor(init: MobileValidateErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status ?? null;
    this.retryable = init.retryable ?? RETRYABLE[init.code] ?? false;
    this.requestId = init.requestId ?? null;
    this.param = init.param ?? null;
    this.docUrl = init.docUrl ?? null;
    this.suggestion = init.suggestion ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  toJSON() {
    return {
      code: this.code, message: this.message, status: this.status, retryable: this.retryable,
      request_id: this.requestId, param: this.param, suggestion: this.suggestion, doc_url: this.docUrl,
    };
  }
}

/** The API answered with an error status. Subclassed per error code below; unknown codes stay `APIError`. */
export class APIError extends MobileValidateError {}

// ---- one class per API error code -------------------------------------------------------------------------------
export class InvalidRequestError extends APIError {}
export class TooManyNumbersError extends APIError {}
export class TestNumberOnlyError extends APIError {}
export class InvalidCursorError extends APIError {}
export class UnauthorizedError extends APIError {}
export class InsufficientBalanceError extends APIError {}
export class CostLimitExceededError extends APIError {}
export class InsufficientScopeError extends APIError {}
export class ServiceDisabledError extends APIError {}
/** The public sandbox key only answers the documented magic numbers and e-mail addresses. */
export class SandboxMagicOnlyError extends APIError {}
export class SuspectedEnumerationError extends APIError {}
export class NotFoundError extends APIError {}
export class IdempotencyKeyReusedError extends APIError {}
export class IdempotencyRequestInProgressError extends APIError {}
export class TestKeyExistsError extends APIError {}
export class PayloadTooLargeError extends APIError {}
export class RateLimitedError extends APIError {}
export class DailyCapReachedError extends APIError {}
export class SpendCapReachedError extends APIError {}
export class InternalServerError extends APIError {}
export class TemporarilyUnavailableError extends APIError {}
/** A 2xx response whose body was not valid JSON. */
export class InvalidResponseError extends APIError {}

/** Aliases with the names other API SDKs use. */
export { UnauthorizedError as AuthenticationError, RateLimitedError as RateLimitError };

// ---- client-side errors -----------------------------------------------------------------------------------------
/** No response: DNS, TLS, connection reset, or the caller aborted. */
export class APIConnectionError extends MobileValidateError {}
/** The request exceeded `timeoutMs`. */
export class APITimeoutError extends APIConnectionError {}
/** No API key was configured. */
export class MissingApiKeyError extends MobileValidateError {}
/** An argument was rejected before any request was sent. */
export class InvalidArgumentError extends MobileValidateError {}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type ErrorClass = new (init: MobileValidateErrorInit) => MobileValidateError;

/** Error class per code. Exported so callers can map codes themselves. */
export const ERROR_CLASSES: Readonly<Record<string, ErrorClass>> = {
  invalid_request: InvalidRequestError,
  too_many_numbers: TooManyNumbersError,
  test_number_only: TestNumberOnlyError,
  invalid_cursor: InvalidCursorError,
  unauthorized: UnauthorizedError,
  insufficient_balance: InsufficientBalanceError,
  cost_limit_exceeded: CostLimitExceededError,
  insufficient_scope: InsufficientScopeError,
  service_disabled: ServiceDisabledError,
  sandbox_magic_only: SandboxMagicOnlyError,
  suspected_enumeration: SuspectedEnumerationError,
  not_found: NotFoundError,
  idempotency_key_reused: IdempotencyKeyReusedError,
  idempotency_request_in_progress: IdempotencyRequestInProgressError,
  test_key_exists: TestKeyExistsError,
  payload_too_large: PayloadTooLargeError,
  rate_limited: RateLimitedError,
  daily_cap_reached: DailyCapReachedError,
  spend_cap_reached: SpendCapReachedError,
  internal_error: InternalServerError,
  temporarily_unavailable: TemporarilyUnavailableError,
  invalid_response: InvalidResponseError,
  connection_error: APIConnectionError,
  timeout: APITimeoutError,
  missing_api_key: MissingApiKeyError,
  invalid_argument: InvalidArgumentError,
};

/** Build the right error subclass for a code (unknown API codes → APIError). */
export function createError(init: MobileValidateErrorInit): MobileValidateError {
  const Cls = ERROR_CLASSES[init.code] ?? (init.status != null ? APIError : MobileValidateError);
  return new Cls(init);
}

function codeForStatus(status: number): ErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "insufficient_scope";
  if (status === 404) return "not_found";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "temporarily_unavailable";
  return status >= 500 ? "internal_error" : "invalid_request";
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Build a typed error from an HTTP error response body (tolerates non-JSON or unexpected bodies). */
export function errorFromResponse(status: number, body: unknown, headers: Headers): MobileValidateError {
  const e = (body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null) as
    | Record<string, unknown>
    | null;
  const code = str(e?.code) ?? codeForStatus(status);
  return createError({
    code,
    message: str(e?.message) ?? `Request failed with status ${status}`,
    status,
    retryable: typeof e?.retryable === "boolean" ? e.retryable : RETRYABLE[code] ?? (status === 408 || status >= 500),
    requestId: str(e?.request_id) ?? headers.get("x-request-id"),
    param: str(e?.param),
    docUrl: str(e?.doc_url),
    suggestion: str(e?.suggestion),
    retryAfterMs: parseRetryAfter(headers.get("retry-after")),
  });
}

/** Retry-After as seconds or HTTP date → milliseconds. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
