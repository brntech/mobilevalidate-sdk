"""E-mail check at sign-up (Python). Same rules as email-check.mjs: fix / confirm / allow.

    python email_check.py registered@test.mobilevalidate.com
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

from mobilevalidate import MobileValidate, MobileValidateError


def decide_email(row: Dict[str, Any]) -> Dict[str, str]:
    if row.get("email_status") != "valid":
        return {"decision": "fix", "message": row.get("suggestion") or "Please check your e-mail address."}
    registered = (row.get("checks") or {}).get("email.valid", {}).get("registered")
    if registered is False:
        return {"decision": "confirm", "message": "We couldn't find this mailbox. Is the address spelled correctly?"}
    return {"decision": "allow"}  # True, or None (unknown, never billed): don't block a real user


def check_signup_email(email: str, mv: Optional[MobileValidate] = None) -> Dict[str, str]:
    mv = mv or (MobileValidate() if os.environ.get("MOBILEVALIDATE_API_KEY") else MobileValidate(sandbox=True))
    try:
        lookup = mv.lookup(emails=[email], checks=["email"], wait=5, wait_timeout=8)
    except MobileValidateError as e:  # fail open; log code + request id, never the address
        print(f"email check failed: {e.code} (request {e.request_id})", file=sys.stderr)
        return {"decision": "allow", "reason": str(e.code)}
    return decide_email(lookup["results"][0])


if __name__ == "__main__":
    print(check_signup_email(sys.argv[1] if len(sys.argv) > 1 else "registered@test.mobilevalidate.com"))
