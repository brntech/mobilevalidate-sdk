from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Union

import httpx
import pytest

from mobilevalidate import AsyncMobileValidate, MobileValidate

KEY = "mv_test_abcdefghijklmnopqrstuvwxyz0123abcdef"

Reply = Union[Dict[str, Any], Exception]


class Recorder:
    """Replays queued replies ({status, body, headers} or an exception) and records requests."""

    def __init__(self, replies: List[Reply]) -> None:
        self.replies = list(replies)
        self.calls: List[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if not self.replies:
            raise AssertionError("no more mock replies")
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        body = r.get("body")
        content = r["raw"] if "raw" in r else (b"" if body is None else json.dumps(body).encode())
        return httpx.Response(r.get("status", 200), content=content,
                              headers={"content-type": "application/json", **r.get("headers", {})})

    def json(self, i: int) -> Any:
        return json.loads(self.calls[i].content)


def make_sync(replies: List[Reply], **kw: Any):
    rec = Recorder(replies)
    sleeps: List[float] = []
    kw.setdefault("api_key", KEY)
    mv = MobileValidate(base_url="http://api.test", http_client=httpx.Client(transport=httpx.MockTransport(rec)),
                        _sleep=sleeps.append, _random=lambda: 1.0, **kw)
    return mv, rec, sleeps


def make_async(replies: List[Reply], **kw: Any):
    rec = Recorder(replies)
    sleeps: List[float] = []

    async def sleep(s: float) -> None:
        sleeps.append(s)

    kw.setdefault("api_key", KEY)
    mv = AsyncMobileValidate(base_url="http://api.test",
                             http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec)),
                             _sleep=sleep, _random=lambda: 1.0, **kw)
    return mv, rec, sleeps


def lookup(status: str = "completed", registered: Optional[bool] = True, lid: str = "lkp_1") -> Dict[str, Any]:
    pending = status == "pending"
    return {
        "object": "lookup", "id": lid, "status": status, "livemode": False, "created_at": "2026-09-25T10:00:00Z",
        "results": [{
            "kind": "phone", "input": "+447700900001", "e164": "+447700900001", "country": "GB",
            "number_status": "valid", "test": True,
            "checks": {"whatsapp.registered": {
                "service": "whatsapp.registered", "status": "pending" if pending else "completed",
                "registered": None if pending else registered, "attributes": None, "confidence": "high",
                "confidence_score": 0.96, "checked_at": "2026-09-25T10:00:00Z", "cached": False, "age_seconds": 0,
                "billed": False, "reason": None, "poll_after_ms": 2000 if pending else None,
                "future_field": "tolerated"}},
        }],
        "summary": {"total": 1, "registered": 0 if pending else 1, "not_registered": 0, "unknown": 0,
                    "pending": 1 if pending else 0, "invalid": 0, "suppressed": 0},
        "next": {"poll_url": f"/v1/lookups/{lid}", "poll_after_ms": 2000} if pending else None,
        "request_id": "req_body",
    }


def error_body(code: str, status: int, retryable: bool, **extra: Any) -> Dict[str, Any]:
    return {"error": {"code": code, "message": f"{code} happened", "status": status, "retryable": retryable,
                      "param": None, "doc_url": f"https://mobilevalidate.com/docs/errors#{code}",
                      "request_id": "req_err", **extra}}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MOBILEVALIDATE_API_KEY", raising=False)
    monkeypatch.delenv("MOBILEVALIDATE_BASE_URL", raising=False)
