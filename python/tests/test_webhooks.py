import base64
import hashlib
import hmac
import json

import pytest

from mobilevalidate import MobileValidate, WebhookVerificationError, sign_webhook, verify_webhook

RAW = b"super-secret-test-key-0123456789"
SECRET = "whsec_" + base64.b64encode(RAW).decode()
BODY = json.dumps({"type": "job.completed", "id": "evt_1", "created_at": "2026-09-25T10:00:00Z",
                   "data": {"object": "job", "id": "job_1", "status": "completed"}})
NOW = 1_790_000_000


def ref_sig(key: bytes, msg_id: str, ts: int, body: str) -> str:
    mac = hmac.new(key, f"{msg_id}.{ts}.{body}".encode(), hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode()


def headers(sig: str, ts: int = NOW):
    return {"webhook-id": "msg_1", "webhook-timestamp": str(ts), "webhook-signature": sig}


def test_valid_signature_returns_event_and_matches_reference():
    sig = ref_sig(RAW, "msg_1", NOW, BODY)
    assert sign_webhook(SECRET, "msg_1", NOW, BODY) == sig
    ev = verify_webhook(BODY, headers(sig), SECRET, now=NOW)
    assert ev["type"] == "job.completed" and ev["data"]["id"] == "job_1"


def test_bytes_body_mixed_case_headers_rotation_and_client_resource():
    sig = ref_sig(RAW, "msg_1", NOW, BODY)
    h = {"Webhook-Id": "msg_1", "Webhook-Timestamp": str(NOW), "Webhook-Signature": f"v1,AAAA v1a,xyz {sig}"}
    ev = MobileValidate("mv_test_x").webhooks.verify(BODY.encode(), h, SECRET, now=NOW)
    assert ev["id"] == "evt_1"


def test_raw_secret_without_prefix_is_utf8():
    secret = "plain-secret-abcd"  # also valid base64: must still be used as UTF-8 bytes, like the server
    sig = ref_sig(secret.encode(), "msg_1", NOW, BODY)
    assert verify_webhook(BODY, headers(sig), secret, now=NOW)["id"] == "evt_1"


def test_tampered_body_rejected():
    sig = ref_sig(RAW, "msg_1", NOW, BODY)
    with pytest.raises(WebhookVerificationError, match="No matching signature"):
        verify_webhook(BODY.replace("completed", "failed"), headers(sig), SECRET, now=NOW)


def test_wrong_secret_rejected():
    sig = ref_sig(b"other", "msg_1", NOW, BODY)
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, headers(sig), SECRET, now=NOW)


def test_old_and_future_timestamps_rejected():
    for ts in (NOW - 301, NOW + 301):
        sig = ref_sig(RAW, "msg_1", ts, BODY)
        with pytest.raises(WebhookVerificationError, match="tolerance"):
            verify_webhook(BODY, headers(sig, ts), SECRET, now=NOW)
    sig = ref_sig(RAW, "msg_1", NOW - 600, BODY)
    assert verify_webhook(BODY, headers(sig, NOW - 600), SECRET, now=NOW, tolerance=900)


def test_missing_headers_and_bad_timestamp():
    with pytest.raises(WebhookVerificationError, match="Missing"):
        verify_webhook(BODY, {}, SECRET, now=NOW)
    with pytest.raises(WebhookVerificationError, match="Invalid webhook-timestamp"):
        verify_webhook(BODY, {"webhook-id": "a", "webhook-timestamp": "abc", "webhook-signature": "v1,x"}, SECRET)


def test_non_json_body_rejected_after_valid_signature():
    sig = ref_sig(RAW, "msg_1", NOW, "not json")
    with pytest.raises(WebhookVerificationError, match="JSON"):
        verify_webhook("not json", headers(sig), SECRET, now=NOW)


def test_httpx_headers_object():
    import httpx

    sig = ref_sig(RAW, "msg_1", NOW, BODY)
    assert verify_webhook(BODY, httpx.Headers(headers(sig)), SECRET, now=NOW)["id"] == "evt_1"
