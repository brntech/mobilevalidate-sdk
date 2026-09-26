"""Standard Webhooks verification (stdlib only).

Signed content: ``f"{webhook-id}.{webhook-timestamp}.{raw body}"``, HMAC-SHA256, base64, header
``webhook-signature: v1,<sig>`` (several space-separated signatures are allowed during secret rotation).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Any, Mapping, Optional, Union

from ._errors import WebhookVerificationError

__all__ = ["verify_webhook", "sign_webhook", "WebhookVerificationError", "DEFAULT_TOLERANCE_SECONDS"]

DEFAULT_TOLERANCE_SECONDS = 300

Payload = Union[str, bytes, bytearray, memoryview]


def _secret_bytes(secret: str) -> bytes:
    """``whsec_<base64>`` → decoded bytes; a secret without the prefix is used as raw UTF-8 bytes (like the server)."""
    if secret.startswith("whsec_"):
        try:
            return base64.b64decode(secret[6:], validate=True)
        except (binascii.Error, ValueError) as e:
            raise WebhookVerificationError("Webhook secret is not valid base64 after 'whsec_'") from e
    return secret.encode("utf-8")


def _header(headers: Any, name: str) -> Optional[str]:
    getter = getattr(headers, "get", None)
    # Case-insensitive mappings (httpx, werkzeug, starlette) answer directly.
    if getter is not None:
        v = getter(name)
        if v is not None:
            return v if isinstance(v, str) else (str(v[0]) if isinstance(v, (list, tuple)) and v else str(v))
    if isinstance(headers, Mapping):
        for k, v in headers.items():
            if isinstance(k, str) and k.lower() == name:
                if isinstance(v, (list, tuple)):
                    return str(v[0]) if v else None
                return None if v is None else str(v)
    return None


def _to_bytes(payload: Payload) -> bytes:
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return bytes(payload)


def sign_webhook(secret: str, msg_id: str, timestamp: Union[int, str], payload: Payload) -> str:
    """Return the ``v1,<base64>`` signature for a payload (useful to test your own receiver)."""
    signed = f"{msg_id}.{timestamp}.".encode("utf-8") + _to_bytes(payload)
    mac = hmac.new(_secret_bytes(secret), signed, hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode("ascii")


def verify_webhook(
    payload: Payload,
    headers: Any,
    secret: str,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[float] = None,
) -> Any:
    """Verify a webhook and return the parsed event (``{"type", "id", "created_at", "data"}``).

    ``payload`` must be the raw request body exactly as received (bytes or str), not re-serialized JSON.
    ``headers`` may be any mapping (case-insensitive lookup is applied). Raises :class:`WebhookVerificationError`.
    """
    msg_id = _header(headers, "webhook-id")
    ts = _header(headers, "webhook-timestamp")
    sig_header = _header(headers, "webhook-signature")
    if not msg_id or not ts or not sig_header:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header")
    if not secret:
        raise WebhookVerificationError("Missing webhook secret")
    if not ts.isdigit():
        raise WebhookVerificationError("Invalid webhook-timestamp")
    current = time.time() if now is None else now
    if abs(current - int(ts)) > tolerance:
        raise WebhookVerificationError("Webhook timestamp outside the tolerance window")

    body = _to_bytes(payload)
    expected = sign_webhook(secret, msg_id, ts, body)[3:]
    valid = any(
        hmac.compare_digest(s[3:].encode("ascii", "replace"), expected.encode("ascii"))
        for s in sig_header.split(" ")
        if s.startswith("v1,")
    )
    if not valid:
        raise WebhookVerificationError("No matching signature")
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise WebhookVerificationError("Webhook body is not valid JSON") from e
