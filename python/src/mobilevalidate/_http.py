"""HTTP transport (sync + async) with retries, jittered backoff, Retry-After and automatic idempotency keys."""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import random as _random
import time
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Iterator, Mapping, Optional, Tuple

import httpx

from ._constants import __version__
from ._errors import (
    APIConnectionError,
    APITimeoutError,
    InvalidResponseError,
    MissingApiKeyError,
    MobileValidateError,
    error_from_response,
)
from .types import APIObject

MAX_BACKOFF_S = 8.0
#: Server hints longer than this are not worth blocking a caller for (e.g. daily caps): the error is raised instead.
MAX_RETRY_AFTER_S = 60.0

Query = Optional[Mapping[str, Any]]


def backoff_seconds(attempt: int, retry_after: Optional[float], rnd: Callable[[], float]) -> float:
    """Exponential backoff with full jitter; Retry-After wins when present."""
    if retry_after is not None:
        return retry_after
    return float(rnd()) * min(MAX_BACKOFF_S, math.ldexp(0.5, attempt))


def _qs_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


class _Base:
    def __init__(
        self,
        *,
        api_key: Optional[str],
        base_url: str,
        timeout: float,
        max_retries: int,
        rnd: Callable[[], float] = _random.random,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.random = rnd

    def _prepare(
        self, method: str, path: str, query: Query, body: Any, idempotency_key: Optional[str],
        accept: str = "application/json",
    ) -> Tuple[str, Dict[str, str], Optional[Dict[str, str]], Optional[bytes]]:
        if not self.api_key:
            raise MissingApiKeyError(
                "No API key. Pass api_key=..., set MOBILEVALIDATE_API_KEY, or use sandbox=True for the public sandbox key."
            )
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": accept,
            "User-Agent": f"mobilevalidate-python/{__version__}",
        }
        content = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            content = json.dumps(body, separators=(",", ":")).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        params = {k: _qs_value(v) for k, v in (query or {}).items() if v is not None}
        return self.base_url + path, headers, params or None, content

    @staticmethod
    def _idempotency(method: str, key: Optional[str]) -> Optional[str]:
        # One key per logical call, reused across retries so the server can deduplicate.
        return (key or str(uuid.uuid4())) if method == "POST" else None

    @staticmethod
    def _parse(response: httpx.Response) -> APIObject:
        headers = response.headers
        text = response.text
        body: Any = None
        parse_failed = False
        if text:
            try:
                body = json.loads(text)
            except ValueError:
                parse_failed = True
        if response.status_code >= 400:
            raise error_from_response(response.status_code, body, headers)
        request_id = headers.get("x-request-id")
        if parse_failed:
            raise InvalidResponseError("Response was not valid JSON", status=response.status_code, request_id=request_id)
        if isinstance(body, dict):
            rid = request_id or (body.get("request_id") if isinstance(body.get("request_id"), str) else None)
            return APIObject(body, rid)
        obj = APIObject({}, request_id)
        if body is not None:
            obj["data"] = body
        return obj

    @staticmethod
    def _wrap_transport_error(e: Exception, timeout: float) -> MobileValidateError:
        if isinstance(e, httpx.TimeoutException):
            return APITimeoutError(f"Request timed out after {timeout:g} s")
        return APIConnectionError(f"Network error: {e}")

    def _should_retry(self, err: MobileValidateError, attempt: int, max_retries: int) -> bool:
        if not err.retryable or attempt >= max_retries:
            return False
        return not (err.retry_after is not None and err.retry_after > MAX_RETRY_AFTER_S)


class SyncTransport(_Base):
    def __init__(
        self,
        *,
        http_client: Optional[httpx.Client] = None,
        sleep: Callable[[float], None] = time.sleep,
        **kw: Any,
    ) -> None:
        super().__init__(**kw)
        self._owns_client = http_client is None
        self.client = http_client or httpx.Client()
        self.sleep = sleep

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Query = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        extra_timeout: float = 0,
        max_retries: Optional[int] = None,
    ) -> APIObject:
        key = self._idempotency(method, idempotency_key)
        url, headers, params, content = self._prepare(method, path, query, body, key)
        total_timeout = (self.timeout if timeout is None else timeout) + extra_timeout
        retries = self.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            try:
                try:
                    response = self.client.request(
                        method, url, headers=headers, params=params, content=content, timeout=total_timeout
                    )
                except httpx.TransportError as e:
                    raise self._wrap_transport_error(e, total_timeout) from e
                return self._parse(response)
            except MobileValidateError as err:
                if not self._should_retry(err, attempt, retries):
                    raise
                self.sleep(backoff_seconds(attempt, err.retry_after, self.random))
                attempt += 1


    @contextlib.contextmanager
    def stream(
        self, path: str, *, query: Query = None, accept: str, timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> Iterator[httpx.Response]:
        """GET a streamed (non-JSON) body. Error responses are parsed and raised like :meth:`request`; the timeout
        covers each read, not the whole transfer."""
        url, headers, params, _ = self._prepare("GET", path, query, None, None, accept)
        total_timeout = self.timeout if timeout is None else timeout
        retries = self.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            try:
                with self.client.stream("GET", url, headers=headers, params=params, timeout=total_timeout) as response:
                    if response.status_code >= 400:
                        response.read()
                        self._parse(response)
                    yield response
                    return
            except httpx.TransportError as e:
                err: MobileValidateError = self._wrap_transport_error(e, total_timeout)
                if not self._should_retry(err, attempt, retries):
                    raise err from e
            except MobileValidateError as e:
                if not self._should_retry(e, attempt, retries):
                    raise
                err = e
            self.sleep(backoff_seconds(attempt, err.retry_after, self.random))
            attempt += 1


class AsyncTransport(_Base):
    def __init__(
        self,
        *,
        http_client: Optional[httpx.AsyncClient] = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        **kw: Any,
    ) -> None:
        super().__init__(**kw)
        self._owns_client = http_client is None
        self.client = http_client or httpx.AsyncClient()
        self.sleep = sleep

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: Query = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        extra_timeout: float = 0,
        max_retries: Optional[int] = None,
    ) -> APIObject:
        key = self._idempotency(method, idempotency_key)
        url, headers, params, content = self._prepare(method, path, query, body, key)
        total_timeout = (self.timeout if timeout is None else timeout) + extra_timeout
        retries = self.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            try:
                try:
                    response = await self.client.request(
                        method, url, headers=headers, params=params, content=content, timeout=total_timeout
                    )
                except httpx.TransportError as e:
                    raise self._wrap_transport_error(e, total_timeout) from e
                return self._parse(response)
            except MobileValidateError as err:
                if not self._should_retry(err, attempt, retries):
                    raise
                await self.sleep(backoff_seconds(attempt, err.retry_after, self.random))
                attempt += 1


    @contextlib.asynccontextmanager
    async def stream(
        self, path: str, *, query: Query = None, accept: str, timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> AsyncIterator[httpx.Response]:
        """GET a streamed (non-JSON) body; see :meth:`SyncTransport.stream`."""
        url, headers, params, _ = self._prepare("GET", path, query, None, None, accept)
        total_timeout = self.timeout if timeout is None else timeout
        retries = self.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            try:
                async with self.client.stream("GET", url, headers=headers, params=params,
                                              timeout=total_timeout) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        self._parse(response)
                    yield response
                    return
            except httpx.TransportError as e:
                err: MobileValidateError = self._wrap_transport_error(e, total_timeout)
                if not self._should_retry(err, attempt, retries):
                    raise err from e
            except MobileValidateError as e:
                if not self._should_retry(e, attempt, retries):
                    raise
                err = e
            await self.sleep(backoff_seconds(attempt, err.retry_after, self.random))
            attempt += 1
