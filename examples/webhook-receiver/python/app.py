"""Webhook receiver (Flask). Verifies the Standard Webhooks signature on the RAW body, answers 2xx fast, ignores
duplicates (same webhook-id) and handles job.completed by paging through the job's results.

    MOBILEVALIDATE_WEBHOOK_SECRET=whsec_... MOBILEVALIDATE_API_KEY=mv_test_... flask --app app run --port 3000

The public sandbox key has no webhooks: use a personal test key (https://mobilevalidate.com/get-test-key).
"""
from __future__ import annotations

import os
import threading
from typing import Any, Callable, Dict, Optional

from flask import Flask, Response, request

from mobilevalidate import MobileValidate, WebhookVerificationError, verify_webhook


def handle_event(event: Dict[str, Any], mv: MobileValidate) -> Optional[Dict[str, int]]:
    if event.get("type") == "job.completed":
        counts = {"registered": 0, "not_registered": 0, "unknown": 0, "invalid": 0}
        for row in mv.jobs.results(event["data"]["id"]):  # auto-paginates
            if (row.get("number_status") or row.get("email_status")) != "valid":
                counts["invalid"] += 1
                continue
            first = next(iter((row.get("checks") or {}).values()), {})
            reg = first.get("registered")
            counts["registered" if reg is True else "not_registered" if reg is False else "unknown"] += 1
        print(f"job {event['data']['id']} completed: {counts}")  # counts only, never numbers
        return counts
    return None


def create_app(secret: str, mv: Optional[MobileValidate] = None,
               on_event: Optional[Callable[[Dict[str, Any], MobileValidate], Any]] = None,
               background: bool = True) -> Flask:
    app = Flask(__name__)
    client = mv or MobileValidate()
    handler = on_event or handle_event
    seen: set = set()  # use a database unique index in production

    @app.post("/webhooks/mobilevalidate")
    def receive() -> Response:
        raw = request.get_data()  # the exact bytes received — verify BEFORE parsing JSON
        try:
            event = verify_webhook(raw, request.headers, secret)  # signature + timestamp (±5 min)
        except WebhookVerificationError as e:
            return Response(str(e), status=400)
        msg_id = request.headers.get("webhook-id", "")
        if msg_id in seen:
            return Response(status=204)
        seen.add(msg_id)
        if background:  # answer fast, work later (use a task queue in production)
            threading.Thread(target=handler, args=(event, client), daemon=True).start()
        else:
            handler(event, client)
        return Response(status=204)

    return app


if os.environ.get("MOBILEVALIDATE_WEBHOOK_SECRET"):
    app = create_app(os.environ["MOBILEVALIDATE_WEBHOOK_SECRET"])
