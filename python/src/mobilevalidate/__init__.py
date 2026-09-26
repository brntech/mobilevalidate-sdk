"""MobileValidate API client for Python — know before you send.

>>> from mobilevalidate import MobileValidate
>>> mv = MobileValidate(sandbox=True)   # or MobileValidate() with MOBILEVALIDATE_API_KEY set
>>> mv.lookup("+447700900001", checks=["whatsapp"])["results"][0]["checks"]["whatsapp.registered"]["registered"]
True
"""

from ._client import AsyncMobileValidate, MobileValidate
from ._constants import (
    DEFAULT_BASE_URL,
    SANDBOX_LIMITS,
    SANDBOX_PUBLIC_KEY,
    TEST_EMAIL_DOMAIN,
    TEST_EMAILS,
    TEST_NUMBERS,
    __version__,
)
from ._errors import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    CostLimitExceededError,
    DailyCapReachedError,
    IdempotencyKeyReusedError,
    IdempotencyRequestInProgressError,
    InsufficientBalanceError,
    InsufficientScopeError,
    InternalServerError,
    InvalidArgumentError,
    InvalidCursorError,
    InvalidRequestError,
    InvalidResponseError,
    MissingApiKeyError,
    MobileValidateError,
    NotFoundError,
    PayloadTooLargeError,
    RateLimitedError,
    RateLimitError,
    SandboxMagicOnlyError,
    ServiceDisabledError,
    SpendCapReachedError,
    SuspectedEnumerationError,
    TemporarilyUnavailableError,
    TestKeyExistsError,
    TestNumberOnlyError,
    TooManyNumbersError,
    UnauthorizedError,
    WebhookVerificationError,
)
from .types import APIObject
from .webhooks import sign_webhook, verify_webhook

__all__ = [
    "MobileValidate", "AsyncMobileValidate", "APIObject", "verify_webhook", "sign_webhook", "__version__",
    "DEFAULT_BASE_URL", "SANDBOX_PUBLIC_KEY", "SANDBOX_LIMITS", "TEST_NUMBERS", "TEST_EMAILS", "TEST_EMAIL_DOMAIN",
    "MobileValidateError", "APIError", "InvalidRequestError", "TooManyNumbersError", "TestNumberOnlyError",
    "InvalidCursorError", "UnauthorizedError", "AuthenticationError", "InsufficientBalanceError",
    "CostLimitExceededError", "InsufficientScopeError", "ServiceDisabledError", "SandboxMagicOnlyError",
    "SuspectedEnumerationError", "NotFoundError", "IdempotencyKeyReusedError", "IdempotencyRequestInProgressError",
    "TestKeyExistsError", "PayloadTooLargeError", "RateLimitedError", "RateLimitError", "DailyCapReachedError",
    "SpendCapReachedError", "InternalServerError", "TemporarilyUnavailableError", "InvalidResponseError",
    "APIConnectionError", "APITimeoutError", "MissingApiKeyError", "InvalidArgumentError", "WebhookVerificationError",
]
