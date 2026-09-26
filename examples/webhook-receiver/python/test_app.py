import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from app import create_app, handle_event  # noqa: E402
from mobilevalidate import TEST_NUMBERS, MobileValidate, sign_webhook  # noqa: E402

SECRET = "whsec_ZXhhbXBsZS13ZWJob29rLXNlY3JldC0wMTIzNDU2Nzg5"
EVENT = json.dumps({"type": "lookup.completed", "id": "evt_1", "created_at": "2026-09-25T10:00:00Z",
                    "data": {"object": "lookup", "id": "lkp_1"}})


def deliver(client, body, msg_id="msg_1", ts=None, sig=None):
    ts = ts or int(time.time())
    sig = sig or sign_webhook(SECRET, msg_id, ts, body)
    return client.post("/webhooks/mobilevalidate", data=body, headers={
        "content-type": "application/json", "webhook-id": msg_id, "webhook-timestamp": str(ts), "webhook-signature": sig})


def test_valid_duplicate_and_invalid_deliveries():
    got = []
    app = create_app(SECRET, mv=MobileValidate(sandbox=True), on_event=lambda e, mv: got.append(e), background=False)
    c = app.test_client()
    assert deliver(c, EVENT, "msg_a").status_code == 204
    assert deliver(c, EVENT, "msg_a").status_code == 204  # redelivery is ignored
    assert len(got) == 1
    assert deliver(c, EVENT.replace("lkp_1", "lkp_2"), "msg_b", sig=sign_webhook(SECRET, "msg_b", int(time.time()), EVENT)).status_code == 400
    assert deliver(c, EVENT, "msg_c", ts=int(time.time()) - 3600).status_code == 400


def test_job_completed_handler_pages_results():
    mv = MobileValidate(sandbox=True)
    job = mv.jobs.create(numbers=[TEST_NUMBERS["registered"], TEST_NUMBERS["not_registered"], TEST_NUMBERS["unknown"]], checks=["whatsapp"])
    mv.jobs.wait(job["id"], wait_timeout=60)
    counts = handle_event({"type": "job.completed", "data": {"id": job["id"]}}, mv)
    assert counts == {"registered": 1, "not_registered": 1, "unknown": 1, "invalid": 0}
