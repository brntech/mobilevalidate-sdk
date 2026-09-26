"""Response types.

Responses are plain ``dict`` objects (``APIObject``, a ``dict`` subclass) so unknown fields added by the API are kept
and ``lookup["results"]`` works as in the JSON docs. Top-level objects also carry ``.request_id``. The TypedDicts
below document the shapes for editors and type checkers; enums are open (new values may appear within /v1).
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Literal, Optional, Union

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:  # pragma: no cover
    from typing_extensions import NotRequired, TypedDict

__all__ = [
    "APIObject", "Money", "CheckResult", "ResultItem", "Summary", "Lookup", "Job", "Estimate", "PriceLine", "Page", "Service",
    "WebhookEndpoint", "WebhookEvent", "MoneyInput", "DurationInput", "DownloadFormat",
]


class APIObject(Dict[str, Any]):
    """A JSON object returned by the API: a ``dict`` with a ``request_id`` attribute (``x-request-id``)."""

    request_id: Optional[str]

    def __init__(self, data: Any = None, request_id: Optional[str] = None) -> None:
        super().__init__(data or {})
        self.request_id = request_id

    def __repr__(self) -> str:
        return f"APIObject({dict.__repr__(self)}, request_id={self.request_id!r})"


class Money(TypedDict):
    amount: str  # decimal string, never a float
    currency: str


class CheckResult(TypedDict, total=False):
    service: str
    status: str  # completed | pending | unknown | unsupported_country | failed
    registered: Optional[bool]  # True / False (conclusive) / None (unknown — never billed)
    attributes: Optional[Dict[str, Union[str, bool, int]]]
    confidence: Optional[str]
    confidence_score: Optional[float]
    checked_at: Optional[str]
    cached: bool
    age_seconds: Optional[int]
    billed: bool
    reason: Optional[str]
    poll_after_ms: Optional[int]


class ResultItem(TypedDict, total=False):
    kind: str  # phone | email (absent = phone)
    input: str
    e164: Optional[str]
    country: Optional[str]
    number_status: str  # valid | invalid_number | duplicate | suppressed
    email: Optional[str]
    email_status: str  # valid | invalid_email | duplicate | suppressed
    checks: Dict[str, CheckResult]
    whatsapp: Dict[str, Any]
    test: bool
    suggestion: str  # plain-English hint for invalid or mistyped identifiers


class Summary(TypedDict, total=False):
    total: int
    registered: int
    not_registered: int
    unknown: int
    pending: int
    invalid: int
    suppressed: int
    by_service: Dict[str, Dict[str, int]]


class Lookup(TypedDict):
    object: str
    id: str
    status: str  # completed | pending
    livemode: bool
    created_at: str
    results: List[ResultItem]
    summary: Summary
    billing: NotRequired[Dict[str, Any]]
    next: NotRequired[Optional[Dict[str, Any]]]
    metadata: NotRequired[Dict[str, str]]
    request_id: str


class Job(TypedDict, total=False):
    object: str
    id: str
    status: str  # queued | preflight | running | merging | completed | failed | cancelled
    created_at: str
    checks: List[str]
    progress: Dict[str, int]
    eta_seconds: Optional[int]
    cost: Dict[str, Any]  # estimated_max / reserved / charged / released: Money; breakdown: List[PriceLine]
    metadata: Dict[str, str]


class PriceLine(TypedDict, total=False):
    """One price line of a bulk job. ``reason == "small_batch"``: a part too small for the batch route (fewer numbers
    per country than ``batch_minimum``), priced at the real-time price."""

    check: str
    price_mode: str
    reason: Optional[str]
    checks: int
    unit_price: Money
    max_cost: Money
    countries: List[str]
    batch_minimum: int


class Estimate(TypedDict, total=False):
    total: int
    valid: int
    invalid: int
    duplicate: int
    cached: int
    unsupported: int
    suppressed: int
    billable_max: int
    max_cost: Money
    checks: List[str]
    checks_total: int
    breakdown: List[PriceLine]


class Page(TypedDict, total=False):
    object: str
    data: List[Any]
    has_more: bool
    next_cursor: Optional[str]


class Service(TypedDict, total=False):
    object: str
    code: str
    name: str
    platform: str  # used descriptively only
    family: str
    description: str
    input_type: str  # phone | email
    result_kind: str  # boolean | attributes
    attributes: List[Dict[str, Any]]
    realtime: bool
    batch: bool
    status: str
    beta: bool
    countries: List[str]
    prices: Dict[str, Optional[Money]]


class WebhookEndpoint(TypedDict, total=False):
    id: str
    url: str
    events: List[str]
    secret: str  # shown once, on create


class WebhookEvent(TypedDict):
    type: str
    id: str
    created_at: str
    data: Dict[str, Any]


#: Money input: decimal string ("0.05"), int/float (0.05) or a Money dict.
MoneyInput = Union[str, int, float, Money, Dict[str, str]]
#: Seconds, or a duration string like "30s", "15m", "24h", "7d".
DurationInput = Union[int, str]
#: File format of ``jobs.download`` / ``jobs.download_to``.
DownloadFormat = Literal["csv", "ndjson"]
