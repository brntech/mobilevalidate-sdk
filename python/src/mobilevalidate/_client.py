"""MobileValidate clients: :class:`MobileValidate` (sync) and :class:`AsyncMobileValidate` (asyncio)."""

from __future__ import annotations

import os
import random
import re
import time
from typing import Any, AsyncIterator, Dict, Iterator, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import httpx

from ._constants import DEFAULT_BASE_URL, SANDBOX_PUBLIC_KEY
from ._errors import InvalidArgumentError, MobileValidateError
from ._http import AsyncTransport, SyncTransport
from .types import APIObject, DownloadFormat, DurationInput, MoneyInput
from .webhooks import DEFAULT_TOLERANCE_SECONDS, verify_webhook

__all__ = ["MobileValidate", "AsyncMobileValidate"]

MAX_SERVER_WAIT_S = 30
TERMINAL_JOB_STATUSES = frozenset({"completed", "failed", "cancelled"})
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

Numbers = Union[str, Sequence[str], None]


# ---------------------------------------------------------------- helpers (shared by sync + async)

def to_money(v: MoneyInput) -> Dict[str, str]:
    """``"0.05"`` / ``0.05`` / ``{"amount": "0.05", "currency": "USD"}`` → Money dict (decimal string, never a float)."""
    if isinstance(v, dict):
        return dict(v)  # type: ignore[arg-type]
    if isinstance(v, bool):
        raise InvalidArgumentError("max_cost must be a non-negative decimal", param="max_cost")
    amount = format(v, "f").rstrip("0").rstrip(".") if isinstance(v, float) else str(v).strip()
    if not re.fullmatch(r"\d+(\.\d+)?", amount or ""):
        raise InvalidArgumentError("max_cost must be a non-negative decimal", param="max_cost")
    return {"amount": amount, "currency": "USD"}


def to_seconds(v: DurationInput) -> int:
    """Seconds, or ``"30s"``, ``"15m"``, ``"24h"``, ``"7d"`` → integer seconds."""
    if isinstance(v, bool):
        raise InvalidArgumentError("max_age must be seconds or like 30s, 15m, 24h, 7d", param="max_age")
    if isinstance(v, (int, float)):
        return max(0, int(v))
    m = re.fullmatch(r"(\d+)\s*([smhd]?)", str(v).strip())
    if not m:
        raise InvalidArgumentError("max_age must be seconds or like 30s, 15m, 24h, 7d", param="max_age")
    return int(m.group(1)) * _UNITS[m.group(2) or "s"]


def _clamp_wait(w: Optional[float], default: int) -> int:
    return min(MAX_SERVER_WAIT_S, max(0, int(default if w is None else w)))


_ACCEPT = {"csv": "text/csv", "ndjson": "application/x-ndjson"}


def _fmt(format: str) -> str:
    if format not in _ACCEPT:
        raise InvalidArgumentError("format must be csv or ndjson", param="format")
    return format


def _compact(d: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _as_list(v: Numbers) -> Optional[List[str]]:
    if v is None:
        return None
    return [v] if isinstance(v, str) else list(v)


def _registered_param(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if v in ("true", "false", "null"):
        return str(v)
    raise InvalidArgumentError("registered must be True, False, 'true', 'false' or 'null'", param="registered")


def _p(s: str) -> str:
    return quote(s, safe="")


def _lookup_body(numbers: Optional[List[str]], emails: Optional[List[str]], wait: int, o: Dict[str, Any]) -> Dict[str, Any]:
    if not numbers and not emails:
        raise InvalidArgumentError("Provide at least one number or e-mail address", param="numbers")
    return _compact({
        "numbers": numbers,
        "emails": emails,
        "checks": list(o["checks"]) if o.get("checks") is not None else None,
        "default_country": o.get("default_country"),
        "max_age": None if o.get("max_age") is None else to_seconds(o["max_age"]),
        "wait": wait,
        "max_cost": None if o.get("max_cost") is None else to_money(o["max_cost"]),
        "metadata": o.get("metadata"),
        "webhook_endpoint_id": o.get("webhook_endpoint_id"),
    })


def _job_body(
    numbers: Numbers, emails: Numbers, upload_id: Optional[str], checks: Optional[Sequence[str]],
    default_country: Optional[str], max_age: Optional[DurationInput], max_cost: Optional[MoneyInput],
    webhook_endpoint_id: Optional[str], metadata: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    return _compact({
        "numbers": _as_list(numbers),
        "emails": _as_list(emails),
        "upload_id": upload_id,
        "checks": list(checks) if checks is not None else None,
        "default_country": default_country,
        "max_age": None if max_age is None else to_seconds(max_age),
        "max_cost": None if max_cost is None else to_money(max_cost),
        "webhook_endpoint_id": webhook_endpoint_id,
        "metadata": metadata,
    })


def _results_query(registered: Any, status: Optional[str], service: Optional[str], limit: Optional[int], after: Optional[str]) -> Dict[str, Any]:
    return {"registered": _registered_param(registered), "status": status, "service": service, "limit": limit, "after": after}


def _resolve_key(api_key: Optional[str], sandbox: bool) -> Optional[str]:
    if api_key:
        return api_key
    if sandbox:
        return SANDBOX_PUBLIC_KEY
    return os.environ.get("MOBILEVALIDATE_API_KEY") or None


def _resolve_base_url(base_url: Optional[str]) -> str:
    return base_url or os.environ.get("MOBILEVALIDATE_BASE_URL") or DEFAULT_BASE_URL


class _Webhooks:
    """``client.webhooks.verify(raw_body, headers, secret)`` — Standard Webhooks signature check."""

    def verify(self, payload: Any, headers: Any, secret: str, *, tolerance: int = DEFAULT_TOLERANCE_SECONDS,
               now: Optional[float] = None) -> Any:
        return verify_webhook(payload, headers, secret, tolerance=tolerance, now=now)


# ---------------------------------------------------------------- sync client

class _SyncResource:
    def __init__(self, client: "MobileValidate") -> None:
        self._c = client
        self._t = client._transport


class Lookups(_SyncResource):
    def get(self, lookup_id: str, *, wait: Optional[int] = None, timeout: Optional[float] = None,
            max_retries: Optional[int] = None) -> APIObject:
        """Fetch a lookup; ``wait`` (0–30 s) long-polls until it completes."""
        w = _clamp_wait(wait, 0)
        return self._t.request("GET", f"/v1/lookups/{_p(lookup_id)}", query={"wait": w or None},
                               extra_timeout=w, timeout=timeout, max_retries=max_retries)


class Jobs(_SyncResource):
    def create(self, *, numbers: Numbers = None, emails: Numbers = None, upload_id: Optional[str] = None,
               checks: Optional[Sequence[str]] = None, default_country: Optional[str] = None,
               max_age: Optional[DurationInput] = None, max_cost: Optional[MoneyInput] = None,
               webhook_endpoint_id: Optional[str] = None, metadata: Optional[Dict[str, str]] = None,
               idempotency_key: Optional[str] = None, timeout: Optional[float] = None,
               max_retries: Optional[int] = None) -> APIObject:
        """Create a bulk job (numbers and/or e-mails, ≤ 50,000 together)."""
        body = _job_body(numbers, emails, upload_id, checks, default_country, max_age, max_cost, webhook_endpoint_id, metadata)
        return self._t.request("POST", "/v1/jobs", body=body, idempotency_key=idempotency_key,
                               timeout=timeout, max_retries=max_retries)

    def estimate(self, *, numbers: Numbers = None, emails: Numbers = None, upload_id: Optional[str] = None,
                 checks: Optional[Sequence[str]] = None, default_country: Optional[str] = None,
                 max_age: Optional[DurationInput] = None, max_cost: Optional[MoneyInput] = None,
                 idempotency_key: Optional[str] = None, timeout: Optional[float] = None,
                 max_retries: Optional[int] = None) -> APIObject:
        """Free pre-flight: counts and maximum cost, no charge."""
        body = _job_body(numbers, emails, upload_id, checks, default_country, max_age, max_cost, None, None)
        return self._t.request("POST", "/v1/jobs/estimate", body=body, idempotency_key=idempotency_key,
                               timeout=timeout, max_retries=max_retries)

    def get(self, job_id: str, *, wait: Optional[int] = None, timeout: Optional[float] = None,
            max_retries: Optional[int] = None) -> APIObject:
        w = _clamp_wait(wait, 0)
        return self._t.request("GET", f"/v1/jobs/{_p(job_id)}", query={"wait": w or None}, extra_timeout=w,
                               timeout=timeout, max_retries=max_retries)

    def wait(self, job_id: str, *, wait_timeout: float = 300.0, timeout: Optional[float] = None) -> APIObject:
        """Long-poll until the job is completed, failed or cancelled, or ``wait_timeout`` seconds pass.

        Returns the last job state (check ``job["status"]``)."""
        deadline = time.monotonic() + wait_timeout
        job = self.get(job_id, timeout=timeout)
        while job.get("status") not in TERMINAL_JOB_STATUSES:
            remaining = int(deadline - time.monotonic())
            if remaining < 1:
                break
            job = self.get(job_id, wait=min(MAX_SERVER_WAIT_S, remaining), timeout=timeout)
            if job.get("status") not in TERMINAL_JOB_STATUSES:
                self._c._sleep(min(1.0, max(0.0, deadline - time.monotonic())))
        return job

    def results_page(self, job_id: str, *, registered: Any = None, status: Optional[str] = None,
                     service: Optional[str] = None, limit: Optional[int] = None, after: Optional[str] = None,
                     timeout: Optional[float] = None) -> APIObject:
        """One page of results (``{"data": [...], "has_more": bool, "next_cursor": str | None}``)."""
        return self._t.request("GET", f"/v1/jobs/{_p(job_id)}/results",
                               query=_results_query(registered, status, service, limit, after), timeout=timeout)

    def results(self, job_id: str, *, registered: Any = None, status: Optional[str] = None,
                service: Optional[str] = None, limit: Optional[int] = None, after: Optional[str] = None,
                timeout: Optional[float] = None) -> Iterator[Dict[str, Any]]:
        """Iterate over every result row, following cursors automatically."""
        cursor = after
        while True:
            page = self.results_page(job_id, registered=registered, status=status, service=service, limit=limit,
                                     after=cursor, timeout=timeout)
            for item in page.get("data") or []:
                yield item
            cursor = page.get("next_cursor")
            if not page.get("has_more") or not cursor:
                return

    def download(self, job_id: str, *, format: DownloadFormat = "csv", timeout: Optional[float] = None) -> str:
        """The whole result file as text: CSV (default, header first) or NDJSON (one JSON object per line).

        For large jobs prefer :meth:`download_to`, which streams to disk."""
        with self._t.stream(f"/v1/jobs/{_p(job_id)}/download", query={"format": _fmt(format)},
                            accept=_ACCEPT[format], timeout=timeout) as r:
            r.read()
            return r.text

    def download_to(self, job_id: str, path: Union[str, "os.PathLike[str]"], *, format: DownloadFormat = "csv",
                    timeout: Optional[float] = None) -> int:
        """Stream the result file to ``path`` (overwritten). Returns the number of bytes written."""
        written = 0
        with self._t.stream(f"/v1/jobs/{_p(job_id)}/download", query={"format": _fmt(format)},
                            accept=_ACCEPT[format], timeout=timeout) as r, open(path, "wb") as f:
            for chunk in r.iter_bytes():
                written += f.write(chunk)
        return written

    def cancel(self, job_id: str, *, timeout: Optional[float] = None) -> APIObject:
        """Cancel a running job (unsubmitted items are released) or purge a finished job's data."""
        return self._t.request("DELETE", f"/v1/jobs/{_p(job_id)}", timeout=timeout)


class Account(_SyncResource):
    def get(self, *, timeout: Optional[float] = None) -> APIObject:
        return self._t.request("GET", "/v1/account", timeout=timeout)


class Limits(_SyncResource):
    def get(self, *, timeout: Optional[float] = None) -> APIObject:
        return self._t.request("GET", "/v1/limits", timeout=timeout)


class Usage(_SyncResource):
    def get(self, *, from_date: str, to_date: str, group_by: Optional[str] = None,
            timeout: Optional[float] = None) -> APIObject:
        """Usage between two dates (YYYY-MM-DD); ``group_by`` = ``"day"`` or ``"service"``."""
        return self._t.request("GET", "/v1/usage", query={"from": from_date, "to": to_date, "group_by": group_by},
                               timeout=timeout)


class WebhookEndpoints(_SyncResource):
    def create(self, *, url: str, events: Sequence[str], idempotency_key: Optional[str] = None,
               timeout: Optional[float] = None) -> APIObject:
        """Register an https endpoint (inactive until the ownership challenge succeeds). The secret is shown once."""
        return self._t.request("POST", "/v1/webhook_endpoints", body={"url": url, "events": list(events)},
                               idempotency_key=idempotency_key, timeout=timeout)

    def list(self, *, timeout: Optional[float] = None) -> APIObject:
        return self._t.request("GET", "/v1/webhook_endpoints", timeout=timeout)

    def delete(self, endpoint_id: str, *, timeout: Optional[float] = None) -> APIObject:
        return self._t.request("DELETE", f"/v1/webhook_endpoints/{_p(endpoint_id)}", timeout=timeout)

    def test(self, endpoint_id: str, *, timeout: Optional[float] = None) -> APIObject:
        """Queue a test event to the endpoint."""
        return self._t.request("POST", f"/v1/webhook_endpoints/{_p(endpoint_id)}/test", body={}, timeout=timeout)


class MobileValidate:
    """Synchronous MobileValidate client.

    >>> mv = MobileValidate(sandbox=True)          # public sandbox key: documented test values only
    >>> lookup = mv.lookup("+447700900001", checks=["whatsapp"])
    >>> lookup["results"][0]["checks"]["whatsapp.registered"]["registered"]
    True
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        sandbox: bool = False,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        wait_timeout: float = 60.0,
        http_client: Optional[httpx.Client] = None,
        _sleep: Any = None,
        _random: Any = None,
    ) -> None:
        self.wait_timeout = wait_timeout
        self._sleep = _sleep or time.sleep
        self._transport = SyncTransport(
            api_key=_resolve_key(api_key, sandbox), base_url=_resolve_base_url(base_url), timeout=timeout,
            max_retries=max_retries, http_client=http_client, sleep=self._sleep, rnd=_random or random.random,
        )
        self.lookups = Lookups(self)
        self.jobs = Jobs(self)
        self.account = Account(self)
        self.limits = Limits(self)
        self.usage = Usage(self)
        self.webhook_endpoints = WebhookEndpoints(self)
        self.webhooks = _Webhooks()

    @property
    def base_url(self) -> str:
        return self._transport.base_url

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> "MobileValidate":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def lookup(
        self,
        numbers: Numbers = None,
        *,
        emails: Numbers = None,
        checks: Optional[Sequence[str]] = None,
        default_country: Optional[str] = None,
        max_age: Optional[DurationInput] = None,
        wait: Optional[int] = None,
        wait_timeout: Optional[float] = None,
        max_cost: Optional[MoneyInput] = None,
        metadata: Optional[Dict[str, str]] = None,
        webhook_endpoint_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> APIObject:
        """Check 1–100 numbers and/or e-mail addresses in real time.

        Waits for slow answers (long-polling) until the lookup completes or ``wait_timeout`` (default 60 s) runs out;
        then the lookup is returned as-is with ``status == "pending"``. ``wait=0`` returns immediately.
        """
        w = _clamp_wait(wait, 10)
        body = _lookup_body(_as_list(numbers), _as_list(emails), w, locals())
        budget = self.wait_timeout if wait_timeout is None else wait_timeout
        deadline = time.monotonic() + budget
        result = self._transport.request("POST", "/v1/lookup", body=body, idempotency_key=idempotency_key,
                                         extra_timeout=w, timeout=timeout, max_retries=max_retries)
        while result.get("status") == "pending" and w > 0:
            remaining = int(deadline - time.monotonic())
            if remaining < 1:
                break
            poll_wait = min(MAX_SERVER_WAIT_S, remaining)
            try:
                nxt = self._transport.request("GET", f"/v1/lookups/{_p(result['id'])}", query={"wait": poll_wait},
                                              extra_timeout=poll_wait, timeout=timeout, max_retries=max_retries)
            except MobileValidateError as err:
                if err.retryable:
                    break  # keep the last good (pending) lookup
                raise
            prev, result = result, nxt
            if result.get("status") == "pending":  # a server that ignores ?wait: back off using its hint
                hint = ((result.get("next") or {}).get("poll_after_ms") or (prev.get("next") or {}).get("poll_after_ms") or 1000)
                pause = min(hint / 1000.0, max(0.0, deadline - time.monotonic()))
                if pause > 0:
                    self._sleep(pause)
        return result

    def services(self, *, timeout: Optional[float] = None) -> APIObject:
        """Service catalog for this key (``GET /v1/services``): codes, real time / bulk, prices, attributes."""
        return self._transport.request("GET", "/v1/services", timeout=timeout)


# ---------------------------------------------------------------- async client

class _AsyncResource:
    def __init__(self, client: "AsyncMobileValidate") -> None:
        self._c = client
        self._t = client._transport


class AsyncLookups(_AsyncResource):
    async def get(self, lookup_id: str, *, wait: Optional[int] = None, timeout: Optional[float] = None,
                  max_retries: Optional[int] = None) -> APIObject:
        w = _clamp_wait(wait, 0)
        return await self._t.request("GET", f"/v1/lookups/{_p(lookup_id)}", query={"wait": w or None},
                                     extra_timeout=w, timeout=timeout, max_retries=max_retries)


class AsyncJobs(_AsyncResource):
    async def create(self, *, numbers: Numbers = None, emails: Numbers = None, upload_id: Optional[str] = None,
                     checks: Optional[Sequence[str]] = None, default_country: Optional[str] = None,
                     max_age: Optional[DurationInput] = None, max_cost: Optional[MoneyInput] = None,
                     webhook_endpoint_id: Optional[str] = None, metadata: Optional[Dict[str, str]] = None,
                     idempotency_key: Optional[str] = None, timeout: Optional[float] = None,
                     max_retries: Optional[int] = None) -> APIObject:
        body = _job_body(numbers, emails, upload_id, checks, default_country, max_age, max_cost, webhook_endpoint_id, metadata)
        return await self._t.request("POST", "/v1/jobs", body=body, idempotency_key=idempotency_key,
                                     timeout=timeout, max_retries=max_retries)

    async def estimate(self, *, numbers: Numbers = None, emails: Numbers = None, upload_id: Optional[str] = None,
                       checks: Optional[Sequence[str]] = None, default_country: Optional[str] = None,
                       max_age: Optional[DurationInput] = None, max_cost: Optional[MoneyInput] = None,
                       idempotency_key: Optional[str] = None, timeout: Optional[float] = None,
                       max_retries: Optional[int] = None) -> APIObject:
        body = _job_body(numbers, emails, upload_id, checks, default_country, max_age, max_cost, None, None)
        return await self._t.request("POST", "/v1/jobs/estimate", body=body, idempotency_key=idempotency_key,
                                     timeout=timeout, max_retries=max_retries)

    async def get(self, job_id: str, *, wait: Optional[int] = None, timeout: Optional[float] = None,
                  max_retries: Optional[int] = None) -> APIObject:
        w = _clamp_wait(wait, 0)
        return await self._t.request("GET", f"/v1/jobs/{_p(job_id)}", query={"wait": w or None}, extra_timeout=w,
                                     timeout=timeout, max_retries=max_retries)

    async def wait(self, job_id: str, *, wait_timeout: float = 300.0, timeout: Optional[float] = None) -> APIObject:
        deadline = time.monotonic() + wait_timeout
        job = await self.get(job_id, timeout=timeout)
        while job.get("status") not in TERMINAL_JOB_STATUSES:
            remaining = int(deadline - time.monotonic())
            if remaining < 1:
                break
            job = await self.get(job_id, wait=min(MAX_SERVER_WAIT_S, remaining), timeout=timeout)
            if job.get("status") not in TERMINAL_JOB_STATUSES:
                await self._c._sleep(min(1.0, max(0.0, deadline - time.monotonic())))
        return job

    async def results_page(self, job_id: str, *, registered: Any = None, status: Optional[str] = None,
                           service: Optional[str] = None, limit: Optional[int] = None, after: Optional[str] = None,
                           timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("GET", f"/v1/jobs/{_p(job_id)}/results",
                                     query=_results_query(registered, status, service, limit, after), timeout=timeout)

    async def results(self, job_id: str, *, registered: Any = None, status: Optional[str] = None,
                      service: Optional[str] = None, limit: Optional[int] = None, after: Optional[str] = None,
                      timeout: Optional[float] = None) -> AsyncIterator[Dict[str, Any]]:
        """``async for item in mv.jobs.results(job_id): ...`` — follows cursors automatically."""
        cursor = after
        while True:
            page = await self.results_page(job_id, registered=registered, status=status, service=service,
                                           limit=limit, after=cursor, timeout=timeout)
            for item in page.get("data") or []:
                yield item
            cursor = page.get("next_cursor")
            if not page.get("has_more") or not cursor:
                return

    async def download(self, job_id: str, *, format: DownloadFormat = "csv", timeout: Optional[float] = None) -> str:
        """The whole result file as text (CSV or NDJSON); see :meth:`MobileValidate.jobs.download`."""
        async with self._t.stream(f"/v1/jobs/{_p(job_id)}/download", query={"format": _fmt(format)},
                                  accept=_ACCEPT[format], timeout=timeout) as r:
            await r.aread()
            return r.text

    async def download_to(self, job_id: str, path: Union[str, "os.PathLike[str]"], *,
                          format: DownloadFormat = "csv", timeout: Optional[float] = None) -> int:
        """Stream the result file to ``path`` (overwritten). Returns the number of bytes written."""
        written = 0
        async with self._t.stream(f"/v1/jobs/{_p(job_id)}/download", query={"format": _fmt(format)},
                                  accept=_ACCEPT[format], timeout=timeout) as r:
            with open(path, "wb") as f:
                async for chunk in r.aiter_bytes():
                    written += f.write(chunk)
        return written

    async def cancel(self, job_id: str, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("DELETE", f"/v1/jobs/{_p(job_id)}", timeout=timeout)


class AsyncAccount(_AsyncResource):
    async def get(self, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("GET", "/v1/account", timeout=timeout)


class AsyncLimits(_AsyncResource):
    async def get(self, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("GET", "/v1/limits", timeout=timeout)


class AsyncUsage(_AsyncResource):
    async def get(self, *, from_date: str, to_date: str, group_by: Optional[str] = None,
                  timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("GET", "/v1/usage", query={"from": from_date, "to": to_date, "group_by": group_by},
                                     timeout=timeout)


class AsyncWebhookEndpoints(_AsyncResource):
    async def create(self, *, url: str, events: Sequence[str], idempotency_key: Optional[str] = None,
                     timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("POST", "/v1/webhook_endpoints", body={"url": url, "events": list(events)},
                                     idempotency_key=idempotency_key, timeout=timeout)

    async def list(self, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("GET", "/v1/webhook_endpoints", timeout=timeout)

    async def delete(self, endpoint_id: str, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("DELETE", f"/v1/webhook_endpoints/{_p(endpoint_id)}", timeout=timeout)

    async def test(self, endpoint_id: str, *, timeout: Optional[float] = None) -> APIObject:
        return await self._t.request("POST", f"/v1/webhook_endpoints/{_p(endpoint_id)}/test", body={}, timeout=timeout)


class AsyncMobileValidate:
    """Asyncio MobileValidate client (same methods as :class:`MobileValidate`, awaitable)."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        sandbox: bool = False,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        wait_timeout: float = 60.0,
        http_client: Optional[httpx.AsyncClient] = None,
        _sleep: Any = None,
        _random: Any = None,
    ) -> None:
        import asyncio

        self.wait_timeout = wait_timeout
        self._sleep = _sleep or asyncio.sleep
        self._transport = AsyncTransport(
            api_key=_resolve_key(api_key, sandbox), base_url=_resolve_base_url(base_url), timeout=timeout,
            max_retries=max_retries, http_client=http_client, sleep=self._sleep, rnd=_random or random.random,
        )
        self.lookups = AsyncLookups(self)
        self.jobs = AsyncJobs(self)
        self.account = AsyncAccount(self)
        self.limits = AsyncLimits(self)
        self.usage = AsyncUsage(self)
        self.webhook_endpoints = AsyncWebhookEndpoints(self)
        self.webhooks = _Webhooks()

    @property
    def base_url(self) -> str:
        return self._transport.base_url

    async def close(self) -> None:
        await self._transport.close()

    async def __aenter__(self) -> "AsyncMobileValidate":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def lookup(
        self,
        numbers: Numbers = None,
        *,
        emails: Numbers = None,
        checks: Optional[Sequence[str]] = None,
        default_country: Optional[str] = None,
        max_age: Optional[DurationInput] = None,
        wait: Optional[int] = None,
        wait_timeout: Optional[float] = None,
        max_cost: Optional[MoneyInput] = None,
        metadata: Optional[Dict[str, str]] = None,
        webhook_endpoint_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> APIObject:
        w = _clamp_wait(wait, 10)
        body = _lookup_body(_as_list(numbers), _as_list(emails), w, locals())
        budget = self.wait_timeout if wait_timeout is None else wait_timeout
        deadline = time.monotonic() + budget
        result = await self._transport.request("POST", "/v1/lookup", body=body, idempotency_key=idempotency_key,
                                               extra_timeout=w, timeout=timeout, max_retries=max_retries)
        while result.get("status") == "pending" and w > 0:
            remaining = int(deadline - time.monotonic())
            if remaining < 1:
                break
            poll_wait = min(MAX_SERVER_WAIT_S, remaining)
            try:
                nxt = await self._transport.request("GET", f"/v1/lookups/{_p(result['id'])}", query={"wait": poll_wait},
                                                    extra_timeout=poll_wait, timeout=timeout, max_retries=max_retries)
            except MobileValidateError as err:
                if err.retryable:
                    break
                raise
            prev, result = result, nxt
            if result.get("status") == "pending":
                hint = ((result.get("next") or {}).get("poll_after_ms") or (prev.get("next") or {}).get("poll_after_ms") or 1000)
                pause = min(hint / 1000.0, max(0.0, deadline - time.monotonic()))
                if pause > 0:
                    await self._sleep(pause)
        return result

    async def services(self, *, timeout: Optional[float] = None) -> APIObject:
        return await self._transport.request("GET", "/v1/services", timeout=timeout)

