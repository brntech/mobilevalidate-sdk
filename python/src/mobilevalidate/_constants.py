"""Public constants: the sandbox key and the documented test values (magic numbers and e-mail addresses)."""

from __future__ import annotations

from typing import Dict

__version__ = "1.0.2"

DEFAULT_BASE_URL = "https://api.mobilevalidate.com"

#: Public sandbox key — public by design. It answers ONLY the documented test values below (any other input is
#: refused with ``sandbox_magic_only``), is limited per client IP, never billed and never reaches a network.
SANDBOX_PUBLIC_KEY = "mv_test_publicSandboxn9ZgneuhR1B9CRfKG3fulym"

#: Server-enforced sandbox limits (per client IP; the key is shared by everyone).
SANDBOX_LIMITS: Dict[str, int] = {"per_minute": 30, "per_day": 1000, "max_job_rows": 10}

#: Magic phone numbers (E.164) → documented answer in test mode (sandbox key and personal test keys).
TEST_NUMBERS: Dict[str, str] = {
    # Magic test numbers: the same answer for every phone service, with any test key (including the sandbox key).
    "registered": "+447700900001",
    "not_registered": "+447700900002",
    "unknown": "+447700900003",  # reason UPSTREAM_TIMEOUT
    "pending": "+447700900004",  # pending for about 5 s, then registered
    "unsupported_country": "+447700900005",
    "business": "+447700900006",  # registered; a business account for whatsapp.business
    "rate_limited": "+447700900429",  # the request fails with rate_limited
    "insufficient_balance": "+447700900402",  # the request fails with insufficient_balance
}

TEST_EMAIL_DOMAIN = "test.mobilevalidate.com"

TEST_EMAILS: Dict[str, str] = {
    # Magic test e-mail addresses: the same answer for every e-mail service.
    "registered": "registered@test.mobilevalidate.com",
    "not_registered": "not-registered@test.mobilevalidate.com",
    "unknown": "unknown@test.mobilevalidate.com",  # reason UPSTREAM_TIMEOUT
    "pending": "pending@test.mobilevalidate.com",  # pending for about 5 s, then registered
    "unsupported": "unsupported@test.mobilevalidate.com",  # unknown, reason UNSUPPORTED_PROVIDER
    "rate_limited": "rate-limited@test.mobilevalidate.com",  # the request fails with rate_limited
    "insufficient_balance": "no-balance@test.mobilevalidate.com",  # the request fails with insufficient_balance
}
