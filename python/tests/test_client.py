from __future__ import annotations

import json
import re

import httpx
import pytest

import mobilevalidate as m
from mobilevalidate import MobileValidate

from conftest import KEY, error_body, lookup, make_sync


def test_lookup_body_headers_and_request_id():
    mv, rec, _ = make_sync([{"status": 200, "body": lookup(), "headers": {"x-request-id": "req_hdr"}}])
    res = mv.lookup("07700 900001", checks=["whatsapp"], default_country="GB", max_age="7d", max_cost=0.05,
                    metadata={"crm": "1"})
    assert res["results"][0]["checks"]["whatsapp.registered"]["registered"] is True
    assert res["results"][0]["checks"]["whatsapp.registered"]["future_field"] == "tolerated"
    assert res.request_id == "req_hdr"
    req = rec.calls[0]
    assert req.method == "POST" and req.url.path == "/v1/lookup"
    assert rec.json(0) == {"numbers": ["07700 900001"], "checks": ["whatsapp"], "default_country": "GB",
                           "max_age": 604800, "wait": 10, "max_cost": {"amount": "0.05", "currency": "USD"},
                           "metadata": {"crm": "1"}}
    assert req.headers["authorization"] == f"Bearer {KEY}"
    assert req.headers["user-agent"] == f"mobilevalidate-python/{m.__version__}"
    assert req.headers["content-type"] == "application/json"
    assert re.fullmatch(r"[0-9a-f-]{36}", req.headers["idempotency-key"])


def test_request_id_falls_back_to_body():
    mv, _, _ = make_sync([{"status": 200, "body": lookup()}])
    assert mv.lookup("+447700900001").request_id == "req_body"


def test_emails_only_lookup_and_caller_idempotency_key():
    mv, rec, _ = make_sync([{"status": 200, "body": lookup()}])
    mv.lookup(emails=["registered@test.mobilevalidate.com"], checks=["email"], idempotency_key="idem-1")
    assert rec.json(0)["emails"] == ["registered@test.mobilevalidate.com"]
    assert "numbers" not in rec.json(0)
    assert rec.calls[0].headers["idempotency-key"] == "idem-1"


def test_long_poll_pending_then_completed():
    mv, rec, _ = make_sync([
        {"status": 202, "body": lookup("pending")},
        {"status": 200, "body": lookup("pending")},
        {"status": 200, "body": lookup("completed")},
    ])
    res = mv.lookup("+447700900004")
    assert res["status"] == "completed"
    assert [f"{c.method} {c.url.path}" for c in rec.calls] == [
        "POST /v1/lookup", "GET /v1/lookups/lkp_1", "GET /v1/lookups/lkp_1"]
    assert int(rec.calls[1].url.params["wait"]) > 0
    assert "idempotency-key" not in rec.calls[1].headers


def test_wait_zero_returns_immediately():
    mv, rec, _ = make_sync([{"status": 202, "body": lookup("pending")}])
    res = mv.lookup("+447700900004", wait=0)
    assert res["status"] == "pending" and rec.json(0)["wait"] == 0 and len(rec.calls) == 1


def test_wait_budget_exhausted_returns_pending():
    mv, rec, _ = make_sync([{"status": 202, "body": lookup("pending")}])
    assert mv.lookup("+447700900004", wait_timeout=0)["status"] == "pending"
    assert len(rec.calls) == 1


def test_retry_429_honours_retry_after_and_reuses_idempotency_key():
    mv, rec, sleeps = make_sync([
        {"status": 429, "body": error_body("rate_limited", 429, True), "headers": {"retry-after": "2"}},
        {"status": 200, "body": lookup()},
    ])
    assert mv.lookup("+447700900001")["status"] == "completed"
    assert sleeps == [2.0]
    assert rec.calls[0].headers["idempotency-key"] == rec.calls[1].headers["idempotency-key"]


def test_retry_429_without_body():
    mv, rec, sleeps = make_sync([{"status": 429, "raw": b""}, {"status": 200, "body": lookup()}])
    mv.lookup("+447700900001")
    assert len(rec.calls) == 2 and sleeps == [0.5]


def test_retry_5xx_and_network_errors_with_backoff_up_to_max_retries():
    mv, rec, sleeps = make_sync([
        httpx.ConnectError("boom"),
        {"status": 503, "body": error_body("temporarily_unavailable", 503, True)},
        {"status": 503, "body": error_body("temporarily_unavailable", 503, True)},
    ])
    with pytest.raises(m.TemporarilyUnavailableError) as ei:
        mv.lookup("+447700900001")
    assert ei.value.retryable and ei.value.status == 503
    assert len(rec.calls) == 3
    assert sleeps == [0.5, 1.0]
    assert len({c.headers["idempotency-key"] for c in rec.calls}) == 1


def test_retry_after_too_long_is_raised():
    mv, rec, sleeps = make_sync([
        {"status": 429, "body": error_body("daily_cap_reached", 429, True), "headers": {"retry-after": "3600"}}])
    with pytest.raises(m.DailyCapReachedError) as ei:
        mv.lookup("+447700900001")
    assert ei.value.retry_after == 3600 and sleeps == [] and len(rec.calls) == 1


def test_retryable_false_is_not_retried_even_on_429():
    mv, rec, _ = make_sync([{"status": 429, "body": error_body("spend_cap_reached", 429, False)}])
    with pytest.raises(m.SpendCapReachedError):
        mv.lookup("+447700900001")
    assert len(rec.calls) == 1


def test_per_call_max_retries_override():
    mv, rec, _ = make_sync([{"status": 500, "body": error_body("internal_error", 500, True)}])
    with pytest.raises(m.InternalServerError):
        mv.lookup("+447700900001", max_retries=0)
    assert len(rec.calls) == 1


def test_timeout_raises_api_timeout_error_after_retries():
    mv, rec, _ = make_sync([httpx.ReadTimeout("slow")] * 3)
    with pytest.raises(m.APITimeoutError) as ei:
        mv.services()
    assert isinstance(ei.value, m.APIConnectionError) and ei.value.code == "timeout" and ei.value.status is None
    assert len(rec.calls) == 3


def test_timeout_is_passed_to_httpx():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["timeout"] = request.extensions["timeout"]
        return httpx.Response(200, json={"object": "list", "data": [], "has_more": False})

    mv = MobileValidate(KEY, base_url="http://api.test", timeout=7,
                        http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    mv.services()
    assert seen["timeout"]["read"] == 7
    mv.services(timeout=2)
    assert seen["timeout"]["read"] == 2


CODES = {
    "invalid_request": (400, m.InvalidRequestError), "too_many_numbers": (400, m.TooManyNumbersError),
    "test_number_only": (400, m.TestNumberOnlyError), "invalid_cursor": (400, m.InvalidCursorError),
    "unauthorized": (401, m.UnauthorizedError), "insufficient_balance": (402, m.InsufficientBalanceError),
    "cost_limit_exceeded": (402, m.CostLimitExceededError), "insufficient_scope": (403, m.InsufficientScopeError),
    "service_disabled": (403, m.ServiceDisabledError), "sandbox_magic_only": (403, m.SandboxMagicOnlyError),
    "suspected_enumeration": (403, m.SuspectedEnumerationError), "not_found": (404, m.NotFoundError),
    "idempotency_key_reused": (409, m.IdempotencyKeyReusedError),
    "test_key_exists": (409, m.TestKeyExistsError), "payload_too_large": (413, m.PayloadTooLargeError),
    "spend_cap_reached": (429, m.SpendCapReachedError),
}


@pytest.mark.parametrize("code", sorted(CODES))
def test_error_class_per_code(code):
    status, cls = CODES[code]
    body = error_body(code, status, False, param="numbers", suggestion="Add the country code, e.g. +44.")
    mv, _, _ = make_sync([{"status": status, "body": body}])
    with pytest.raises(cls) as ei:
        mv.lookup("+447700900001")
    e = ei.value
    assert isinstance(e, m.APIError) and isinstance(e, m.MobileValidateError)
    assert (e.code, e.status, e.retryable, e.param, e.request_id) == (code, status, False, "numbers", "req_err")
    assert e.suggestion == "Add the country code, e.g. +44."
    assert e.doc_url == f"https://mobilevalidate.com/docs/errors#{code}"
    assert "suggestion: Add the country code" in str(e)


@pytest.mark.parametrize("code,status,cls", [
    ("rate_limited", 429, m.RateLimitedError), ("daily_cap_reached", 429, m.DailyCapReachedError),
    ("internal_error", 500, m.InternalServerError), ("temporarily_unavailable", 503, m.TemporarilyUnavailableError),
    ("idempotency_request_in_progress", 409, m.IdempotencyRequestInProgressError),
])
def test_retryable_error_classes(code, status, cls):
    mv, rec, _ = make_sync([{"status": status, "body": error_body(code, status, True)}] * 3)
    with pytest.raises(cls) as ei:
        mv.services()
    assert ei.value.retryable and len(rec.calls) == 3


def test_aliases_and_unknown_codes():
    assert m.AuthenticationError is m.UnauthorizedError and m.RateLimitError is m.RateLimitedError
    mv, _, _ = make_sync([{"status": 418, "body": error_body("brand_new_code", 418, False)}])
    with pytest.raises(m.APIError) as ei:
        mv.services()
    assert type(ei.value) is m.APIError and ei.value.code == "brand_new_code"


def test_status_mapping_without_body_and_header_request_id():
    mv, _, _ = make_sync([{"status": 404, "raw": b"not json", "headers": {"x-request-id": "req_h"}}])
    with pytest.raises(m.NotFoundError) as ei:
        mv.jobs.get("job_x")
    assert ei.value.request_id == "req_h" and ei.value.code == "not_found"


def test_invalid_json_on_success():
    mv, _, _ = make_sync([{"status": 200, "raw": b"<html>"}])
    with pytest.raises(m.InvalidResponseError):
        mv.services()


def test_missing_key_raises_before_request():
    mv = MobileValidate(base_url="http://api.test",
                        http_client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    with pytest.raises(m.MissingApiKeyError) as ei:
        mv.services()
    assert "MOBILEVALIDATE_API_KEY" in ei.value.message and "sandbox=True" in ei.value.message


def test_env_key_and_base_url(monkeypatch):
    monkeypatch.setenv("MOBILEVALIDATE_API_KEY", "mv_test_fromenv")
    monkeypatch.setenv("MOBILEVALIDATE_BASE_URL", "http://env.test/")
    seen = {}

    def handler(request):
        seen["auth"], seen["host"] = request.headers["authorization"], request.url.host
        return httpx.Response(200, json={"object": "list", "data": [], "has_more": False})

    MobileValidate(http_client=httpx.Client(transport=httpx.MockTransport(handler))).services()
    assert seen == {"auth": "Bearer mv_test_fromenv", "host": "env.test"}


def test_sandbox_uses_constant_and_ignores_env(monkeypatch):
    monkeypatch.setenv("MOBILEVALIDATE_API_KEY", "mv_live_should_not_be_used")
    mv, rec, _ = make_sync([{"status": 200, "body": lookup()}], api_key=None, sandbox=True)
    mv.lookup("+447700900001")
    assert rec.calls[0].headers["authorization"] == f"Bearer {m.SANDBOX_PUBLIC_KEY}"
    # an explicit key still wins
    mv2, rec2, _ = make_sync([{"status": 200, "body": lookup()}], api_key="mv_test_explicit", sandbox=True)
    mv2.lookup("+447700900001")
    assert rec2.calls[0].headers["authorization"] == "Bearer mv_test_explicit"


def test_invalid_arguments_do_not_call_api():
    mv, rec, _ = make_sync([])
    with pytest.raises(m.InvalidArgumentError):
        mv.lookup("+447700900001", max_age="forever")
    with pytest.raises(m.InvalidArgumentError):
        mv.lookup("+447700900001", max_cost="-1")
    with pytest.raises(m.InvalidArgumentError):
        mv.lookup()
    assert rec.calls == []


def _page(ids, cursor):
    return {"object": "list", "data": [{"input": i} for i in ids], "has_more": cursor is not None, "next_cursor": cursor}


def test_job_results_auto_paginates():
    mv, rec, _ = make_sync([{"status": 200, "body": _page(["a", "b"], "c1")}, {"status": 200, "body": _page(["c"], None)}])
    rows = list(mv.jobs.results("job_1", registered=True, service="whatsapp", limit=2))
    assert [r["input"] for r in rows] == ["a", "b", "c"]
    assert rec.calls[0].url.params.get("after") is None
    assert rec.calls[1].url.params["after"] == "c1"
    assert rec.calls[1].url.params["registered"] == "true" and rec.calls[1].url.params["limit"] == "2"


def test_jobs_create_estimate_wait_download_cancel():
    job = lambda s: {"object": "job", "id": "job_1", "status": s, "created_at": "2026-09-25T10:00:00Z"}  # noqa: E731
    mv, rec, sleeps = make_sync([
        {"status": 200, "body": {"total": 2, "max_cost": {"amount": "0.01", "currency": "USD"}}},
        {"status": 201, "body": job("queued")},
        {"status": 200, "body": job("running")},
        {"status": 200, "body": job("running")},
        {"status": 200, "body": job("completed")},
        {"status": 200, "raw": b"row_no,e164\r\n1,+447700900001\r\n", "headers": {"content-type": "text/csv; charset=utf-8"}},
        {"status": 200, "body": job("cancelled")},
    ])
    est = mv.jobs.estimate(numbers=["+447700900001", "+447700900002"], checks=["whatsapp"])
    assert est["max_cost"]["amount"] == "0.01"
    created = mv.jobs.create(numbers=["+447700900001", "+447700900002"], checks=["whatsapp"],
                             max_cost=est["max_cost"]["amount"], max_age=3600)
    assert rec.json(1) == {"numbers": ["+447700900001", "+447700900002"], "checks": ["whatsapp"], "max_age": 3600,
                           "max_cost": {"amount": "0.01", "currency": "USD"}}
    assert rec.calls[0].headers["idempotency-key"] != rec.calls[1].headers["idempotency-key"]
    done = mv.jobs.wait(created["id"], wait_timeout=120)
    assert done["status"] == "completed"
    assert rec.calls[2].url.params.get("wait") is None and int(rec.calls[3].url.params["wait"]) == 30
    assert mv.jobs.download("job_1") == "row_no,e164\r\n1,+447700900001\r\n"
    assert rec.calls[5].url.params["format"] == "csv" and rec.calls[5].headers["accept"] == "text/csv"
    assert mv.jobs.cancel("job_1")["status"] == "cancelled" and rec.calls[6].method == "DELETE"


def test_misc_resources():
    ok = {"status": 200, "body": {"ok": True}}
    mv, rec, _ = make_sync([ok, ok, ok, ok, ok, ok, ok, ok])
    mv.account.get(); mv.limits.get()
    mv.usage.get(from_date="2026-09-01", to_date="2026-09-30", group_by="day")
    mv.webhook_endpoints.create(url="https://example.com/hook", events=["job.completed"])
    mv.webhook_endpoints.list(); mv.webhook_endpoints.delete("we_1"); mv.webhook_endpoints.test("we_1")
    mv.lookups.get("lkp_1", wait=5)
    got = [f"{c.method} {c.url.path}" for c in rec.calls]
    assert got == ["GET /v1/account", "GET /v1/limits", "GET /v1/usage", "POST /v1/webhook_endpoints",
                   "GET /v1/webhook_endpoints", "DELETE /v1/webhook_endpoints/we_1",
                   "POST /v1/webhook_endpoints/we_1/test", "GET /v1/lookups/lkp_1"]
    assert rec.calls[2].url.params["from"] == "2026-09-01"
    assert rec.json(3) == {"url": "https://example.com/hook", "events": ["job.completed"]}
    assert rec.calls[7].url.params["wait"] == "5"


def test_context_manager_closes_owned_client():
    with MobileValidate(KEY) as mv:
        client = mv._transport.client
    assert client.is_closed


def test_jobs_download_ndjson_to_file_and_errors(tmp_path):
    body = b'{"row_no":1,"e164":"+447700900001"}\n{"row_no":2,"e164":"+447700900002"}\n'
    mv, rec, sleeps = make_sync([
        {"status": 200, "raw": body, "headers": {"content-type": "application/x-ndjson"}},
        {"status": 503, "body": {"error": {"code": "temporarily_unavailable", "message": "x", "status": 503, "retryable": True}}},
        {"status": 200, "raw": body, "headers": {"content-type": "application/x-ndjson"}},
        {"status": 404, "body": {"error": {"code": "not_found", "message": "Results for this job were purged.", "status": 404}}},
    ])
    text = mv.jobs.download("job_1", format="ndjson")
    assert [json.loads(line)["row_no"] for line in text.splitlines()] == [1, 2]
    assert rec.calls[0].headers["accept"] == "application/x-ndjson"
    out = tmp_path / "job_1.ndjson"
    assert mv.jobs.download_to("job_1", out, format="ndjson") == len(body)
    assert out.read_bytes() == body and len(sleeps) == 1
    with pytest.raises(m.NotFoundError):
        mv.jobs.download("job_1")
