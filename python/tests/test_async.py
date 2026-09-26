import httpx
import pytest

import mobilevalidate as m

from conftest import error_body, lookup, make_async

pytestmark = pytest.mark.asyncio


async def test_async_lookup_long_polls_and_request_id():
    mv, rec, _ = make_async([
        {"status": 202, "body": lookup("pending")},
        {"status": 200, "body": lookup("completed"), "headers": {"x-request-id": "req_a"}},
    ])
    res = await mv.lookup("+447700900004", checks=["whatsapp"])
    assert res["status"] == "completed" and res.request_id == "req_a"
    assert [c.method for c in rec.calls] == ["POST", "GET"]
    await mv.close()


async def test_async_retries_reuse_idempotency_key():
    mv, rec, sleeps = make_async([
        {"status": 429, "body": error_body("rate_limited", 429, True), "headers": {"retry-after": "1"}},
        httpx.ConnectError("boom"),
        {"status": 200, "body": lookup()},
    ])
    await mv.lookup("+447700900001")
    assert sleeps == [1.0, 1.0]
    assert len({c.headers["idempotency-key"] for c in rec.calls}) == 1


async def test_async_errors_and_timeout():
    mv, _, _ = make_async([{"status": 403, "body": error_body("sandbox_magic_only", 403, False,
                                                              suggestion="Use a test value.")}])
    with pytest.raises(m.SandboxMagicOnlyError) as ei:
        await mv.lookup("+447700900001")
    assert ei.value.suggestion == "Use a test value."
    mv2, rec2, _ = make_async([httpx.ConnectTimeout("slow")] * 3)
    with pytest.raises(m.APITimeoutError):
        await mv2.services()
    assert len(rec2.calls) == 3


async def test_async_pagination_and_jobs_wait():
    job = lambda s: {"object": "job", "id": "job_1", "status": s}  # noqa: E731
    mv, rec, _ = make_async([
        {"status": 200, "body": job("running")},
        {"status": 200, "body": job("completed")},
        {"status": 200, "body": {"data": [{"input": "a"}], "has_more": True, "next_cursor": "c1"}},
        {"status": 200, "body": {"data": [{"input": "b"}], "has_more": False, "next_cursor": None}},
    ])
    assert (await mv.jobs.wait("job_1", wait_timeout=60))["status"] == "completed"
    rows = [r["input"] async for r in mv.jobs.results("job_1")]
    assert rows == ["a", "b"] and rec.calls[3].url.params["after"] == "c1"


async def test_async_sandbox_and_missing_key(monkeypatch):
    monkeypatch.setenv("MOBILEVALIDATE_API_KEY", "mv_live_ignored")
    mv, rec, _ = make_async([{"status": 200, "body": {"data": [], "has_more": False}}], api_key=None, sandbox=True)
    await mv.services()
    assert rec.calls[0].headers["authorization"] == f"Bearer {m.SANDBOX_PUBLIC_KEY}"
    monkeypatch.delenv("MOBILEVALIDATE_API_KEY")
    async with m.AsyncMobileValidate() as bare:
        with pytest.raises(m.MissingApiKeyError):
            await bare.services()


async def test_async_resources():
    ok = {"status": 200, "body": {"ok": True}}
    mv, rec, _ = make_async([ok] * 6)
    await mv.jobs.create(emails=["registered@test.mobilevalidate.com"], checks=["email"])
    await mv.jobs.estimate(numbers="+447700900001")
    await mv.account.get()
    await mv.webhook_endpoints.test("we_1")
    await mv.jobs.cancel("job_1")
    await mv.lookups.get("lkp_1")
    assert [f"{c.method} {c.url.path}" for c in rec.calls] == [
        "POST /v1/jobs", "POST /v1/jobs/estimate", "GET /v1/account", "POST /v1/webhook_endpoints/we_1/test",
        "DELETE /v1/jobs/job_1", "GET /v1/lookups/lkp_1"]
    assert rec.json(1) == {"numbers": ["+447700900001"]}


async def test_async_jobs_download(tmp_path):
    csv = b"row_no,e164\r\n1,+447700900001\r\n"
    mv, rec, _ = make_async([{"status": 200, "raw": csv, "headers": {"content-type": "text/csv"}}] * 2)
    assert await mv.jobs.download("job_1") == csv.decode()
    out = tmp_path / "r.csv"
    assert await mv.jobs.download_to("job_1", str(out)) == len(csv)
    assert out.read_bytes() == csv and rec.calls[1].url.params["format"] == "csv"
