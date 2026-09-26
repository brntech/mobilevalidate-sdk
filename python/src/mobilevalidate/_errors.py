"""Typed errors. Every API error code has its own class; all derive from :class:`MobileValidateError`."""

from __future__ import annotations

import email.utils
import time
from typing import Any, Dict, Mapping, Optional, Type

__all__ = [
    "MobileValidateError",
    "APIError",
    "InvalidRequestError",
    "TooManyNumbersError",
    "TestNumberOnlyError",
    "InvalidCursorError",
    "UnauthorizedError",
    "AuthenticationError",
    "InsufficientBalanceError",
    "CostLimitExceededError",
    "InsufficientScopeError",
    "ServiceDisabledError",
    "SandboxMagicOnlyError",
    "SuspectedEnumerationError",
    "NotFoundError",
    "IdempotencyKeyReusedError",
    "IdempotencyRequestInProgressError",
    "TestKeyExistsError",
    "PayloadTooLargeError",
    "RateLimitedError",
    "RateLimitError",
    "DailyCapReachedError",
    "SpendCapReachedError",
    "InternalServerError",
    "TemporarilyUnavailableError",
    "InvalidResponseError",
    "APIConnectionError",
    "APITimeoutError",
    "MissingApiKeyError",
    "InvalidArgumentError",
    "WebhookVerificationError",
]

# Retryability per code, used when the error body does not say.
_RETRYABLE = {
    "idempotency_request_in_progress": True,
    "rate_limited": True,
    "daily_cap_reached": True,
    "internal_error": True,
    "temporarily_unavailable": True,
    "connection_error": True,
    "timeout": True,
}


class MobileValidateError(Exception):
    """Base class of every error raised by the SDK (except :class:`WebhookVerificationError`)."""

    default_code = "error"

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        status: Optional[int] = None,
        retryable: Optional[bool] = None,
        request_id: Optional[str] = None,
        param: Optional[str] = None,
        doc_url: Optional[str] = None,
        suggestion: Optional[str] = None,
        retry_after: Optional[float] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code: str = code or self.default_code
        #: HTTP status, or ``None`` when no response was received.
        self.status = status
        self.retryable: bool = retryable if retryable is not None else _RETRYABLE.get(self.code, False)
        self.request_id = request_id
        self.param = param
        self.doc_url = doc_url
        #: Plain-English hint on how to fix the request (may be ``None``).
        self.suggestion = suggestion
        #: Server ``Retry-After`` hint in seconds (may be ``None``).
        self.retry_after = retry_after
        self.body = body

    def __str__(self) -> str:
        s = f"{self.code}: {self.message}"
        if self.suggestion:
            s += f" (suggestion: {self.suggestion})"
        if self.request_id:
            s += f" [request {self.request_id}]"
        return s

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, status={self.status!r}, message={self.message!r})"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "status": self.status,
            "retryable": self.retryable,
            "request_id": self.request_id,
            "param": self.param,
            "doc_url": self.doc_url,
            "suggestion": self.suggestion,
        }


class APIError(MobileValidateError):
    """The API answered with an error response. Unknown codes are raised as this class."""

    default_code = "api_error"



class InvalidRequestError(APIError):
    """400 invalid_request: the request is malformed or a parameter is invalid (see ``param``)."""

    default_code = "invalid_request"


class TooManyNumbersError(APIError):
    """400 too_many_numbers: too many identifiers in one request."""

    default_code = "too_many_numbers"


class TestNumberOnlyError(APIError):
    """400 test_number_only: test values used with a live key (or vice versa)."""

    __test__ = False  # not a pytest test class
    default_code = "test_number_only"


class InvalidCursorError(APIError):
    """400 invalid_cursor: the pagination cursor is invalid or expired."""

    default_code = "invalid_cursor"


class UnauthorizedError(APIError):
    """401 unauthorized: missing, malformed or revoked API key."""

    default_code = "unauthorized"


AuthenticationError = UnauthorizedError


class InsufficientBalanceError(APIError):
    """402 insufficient_balance: not enough credit for this request."""

    default_code = "insufficient_balance"


class CostLimitExceededError(APIError):
    """402 cost_limit_exceeded: the maximum possible cost is above ``max_cost``."""

    default_code = "cost_limit_exceeded"


class InsufficientScopeError(APIError):
    """403 insufficient_scope: the key may not use this endpoint."""

    default_code = "insufficient_scope"


class ServiceDisabledError(APIError):
    """403 service_disabled: a requested check is not available (or bulk only)."""

    default_code = "service_disabled"


class SandboxMagicOnlyError(APIError):
    """403 sandbox_magic_only: the public sandbox key only answers the documented test values."""

    default_code = "sandbox_magic_only"


class SuspectedEnumerationError(APIError):
    """403 suspected_enumeration: the input looks like a generated list."""

    default_code = "suspected_enumeration"


class NotFoundError(APIError):
    """404 not_found: unknown resource or route."""

    default_code = "not_found"


class IdempotencyKeyReusedError(APIError):
    """409 idempotency_key_reused: the key was used with a different request body."""

    default_code = "idempotency_key_reused"


class IdempotencyRequestInProgressError(APIError):
    """409 idempotency_request_in_progress: the same request is still running (retryable)."""

    default_code = "idempotency_request_in_progress"


class TestKeyExistsError(APIError):
    """409 test_key_exists: this e-mail address already has an active test key."""

    __test__ = False
    default_code = "test_key_exists"


class PayloadTooLargeError(APIError):
    """413 payload_too_large."""

    default_code = "payload_too_large"


class RateLimitedError(APIError):
    """429 rate_limited: slow down (retryable; honours Retry-After)."""

    default_code = "rate_limited"


RateLimitError = RateLimitedError


class DailyCapReachedError(APIError):
    """429 daily_cap_reached."""

    default_code = "daily_cap_reached"


class SpendCapReachedError(APIError):
    """429 spend_cap_reached: the key's spend cap is reached (not retryable)."""

    default_code = "spend_cap_reached"


class InternalServerError(APIError):
    """500 internal_error (retryable)."""

    default_code = "internal_error"


class TemporarilyUnavailableError(APIError):
    """503 temporarily_unavailable (retryable)."""

    default_code = "temporarily_unavailable"


class InvalidResponseError(APIError):
    """The response was not valid JSON."""

    default_code = "invalid_response"


class APIConnectionError(MobileValidateError):
    """No usable response: network failure (retryable)."""

    default_code = "connection_error"


class APITimeoutError(APIConnectionError):
    """The request timed out (retryable)."""

    default_code = "timeout"


class MissingApiKeyError(MobileValidateError):
    """No API key: pass ``api_key=``, set ``MOBILEVALIDATE_API_KEY`` or use ``sandbox=True``."""

    default_code = "missing_api_key"


class InvalidArgumentError(MobileValidateError):
    """An argument was rejected by the SDK before any request was sent."""

    default_code = "invalid_argument"


class WebhookVerificationError(Exception):
    """A webhook signature, timestamp or body could not be verified."""


ERROR_CLASSES: Dict[str, Type[MobileValidateError]] = {
    c.default_code: c
    for c in (
        InvalidRequestError, TooManyNumbersError, TestNumberOnlyError, InvalidCursorError, UnauthorizedError,
        InsufficientBalanceError, CostLimitExceededError, InsufficientScopeError, ServiceDisabledError,
        SandboxMagicOnlyError, SuspectedEnumerationError, NotFoundError, IdempotencyKeyReusedError,
        IdempotencyRequestInProgressError, TestKeyExistsError, PayloadTooLargeError, RateLimitedError,
        DailyCapReachedError, SpendCapReachedError, InternalServerError, TemporarilyUnavailableError,
        InvalidResponseError, APIConnectionError, APITimeoutError, MissingApiKeyError, InvalidArgumentError,
    )
}


def _code_for_status(status: int) -> str:
    if status == 400:
        return "invalid_request"
    if status == 401:
        return "unauthorized"
    if status == 403:
        return "insufficient_scope"
    if status == 404:
        return "not_found"
    if status == 413:
        return "payload_too_large"
    if status == 429:
        return "rate_limited"
    if status == 503:
        return "temporarily_unavailable"
    return "internal_error" if status >= 500 else "invalid_request"


def parse_retry_after(value: Optional[str]) -> Optional[float]:
    """Retry-After as seconds or an HTTP date → seconds (``None`` if absent/invalid)."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    return max(0.0, dt.timestamp() - time.time())


def make_error(code: str, message: str, **kw: Any) -> MobileValidateError:
    cls = ERROR_CLASSES.get(code, APIError)
    return cls(message, code=code, **kw)


def error_from_response(status: int, body: Any, headers: Mapping[str, str]) -> MobileValidateError:
    raw = body.get("error") if isinstance(body, dict) else None
    e: Dict[str, Any] = raw if isinstance(raw, dict) else {}

    def s(k: str) -> Optional[str]:
        v = e.get(k)
        return v if isinstance(v, str) else None

    code = s("code") or _code_for_status(status)
    retryable = e.get("retryable")
    if not isinstance(retryable, bool):
        retryable = _RETRYABLE.get(code, status == 408 or status >= 500)
    return make_error(
        code,
        s("message") or f"Request failed with status {status}",
        status=status,
        retryable=retryable,
        request_id=s("request_id") or headers.get("x-request-id"),
        param=s("param"),
        doc_url=s("doc_url"),
        suggestion=s("suggestion"),
        retry_after=parse_retry_after(headers.get("retry-after")),
        body=body,
    )
