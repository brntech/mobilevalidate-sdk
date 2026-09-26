"""Clean a contact list before a campaign or a CRM import: dedupe, validate, and add a verdict per row.

    python clean_list.py list.csv cleaned.csv [--checks whatsapp,email]

Reads a CSV with a phone column (phone, number, mobile, msisdn or e164) and/or an email column, sends each distinct
value once (a lookup for up to 100 values, otherwise a bulk job), and writes the original rows plus:
  verdict        ok / check_address / invalid / unknown / duplicate
  reachable_on   channels the number is registered on (e.g. "whatsapp")
  suggestion     how to fix an invalid value, when the API has a hint
Key: MOBILEVALIDATE_API_KEY. Without it the public sandbox key is used: test values only, jobs of up to 10 rows.
"""
from __future__ import annotations

import csv
import sys
from typing import Dict, Iterable, List, Optional, Tuple

from mobilevalidate import MobileValidate, MobileValidateError

PHONE_COLUMNS = ("phone", "phone_number", "number", "mobile", "msisdn", "e164")
EMAIL_COLUMNS = ("email", "e-mail", "email_address", "mail")
LOOKUP_MAX = 100


def make_client() -> MobileValidate:
    import os

    return MobileValidate() if os.environ.get("MOBILEVALIDATE_API_KEY") else MobileValidate(sandbox=True)


def mask(value: str) -> str:
    """Never log full numbers or addresses: "+447700900001" -> "+44••••••••01"."""
    if "@" in value:
        local, _, domain = value.partition("@")
        return f"{local[:2]}•••@{domain}"
    return value[:3] + "•" * max(3, len(value) - 5) + value[-2:] if len(value) >= 6 else "•••"


def find_column(header: Iterable[str], names: Tuple[str, ...]) -> Optional[str]:
    for h in header:
        if h.strip().lower() in names:
            return h
    return None


def row_verdict(item: Dict) -> Tuple[str, List[str], str]:
    """(verdict, reachable_on, suggestion) for one result row. Unknown (None) is its own verdict, never "no"."""
    status = item.get("number_status") or item.get("email_status") or "valid"
    if status == "duplicate":
        return "duplicate", [], ""
    if status != "valid":
        return "invalid", [], item.get("suggestion") or ""
    checks = item.get("checks") or {}
    reachable = [code.split(".")[0] for code, c in checks.items() if c.get("registered") is True and not code.startswith("email.")]
    answers = [c.get("registered") for c in checks.values()]
    if item.get("kind") == "email":
        email = checks.get("email.valid", {}).get("registered")
        verdict = "ok" if email is True else "check_address" if email is False else "unknown"
    elif any(a is True for a in answers):
        verdict = "ok"
    elif answers and all(a is False for a in answers):
        verdict = "not_reachable"
    else:
        verdict = "unknown"
    return verdict, reachable, ""


def check_values(mv: MobileValidate, numbers: List[str], emails: List[str], checks: List[str]) -> Dict[str, Dict]:
    """Check distinct values; returns {input: result row}."""
    phone_checks = [c for c in checks if c != "email"] if numbers else []
    email_checks = ["email"] if emails else []
    wanted = phone_checks + email_checks
    if len(numbers) + len(emails) <= LOOKUP_MAX:
        rows = mv.lookup(numbers or None, emails=emails or None, checks=wanted)["results"]
    else:
        job = mv.jobs.create(numbers=numbers or None, emails=emails or None, checks=wanted)
        job = mv.jobs.wait(job["id"], wait_timeout=600)
        if job["status"] != "completed":
            raise RuntimeError(f"job {job['id']} ended as {job['status']}")
        rows = list(mv.jobs.results(job["id"]))  # auto-paginates
    return {r["input"]: r for r in rows}


def clean(src: str, dst: str, checks: Optional[List[str]] = None, mv: Optional[MobileValidate] = None) -> Dict[str, int]:
    checks = checks or ["whatsapp"]
    mv = mv or make_client()
    with open(src, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        header = list(reader.fieldnames or [])
        rows = list(reader)
    phone_col, email_col = find_column(header, PHONE_COLUMNS), find_column(header, EMAIL_COLUMNS)
    if not phone_col and not email_col:
        raise SystemExit(f"No phone or email column found in {src} (looked for {', '.join(PHONE_COLUMNS + EMAIL_COLUMNS)})")

    # Dedupe before sending: each distinct value is checked (and billed) once.
    numbers = list(dict.fromkeys(r[phone_col].strip() for r in rows if phone_col and r.get(phone_col, "").strip()))
    emails = list(dict.fromkeys(r[email_col].strip() for r in rows if email_col and r.get(email_col, "").strip()))
    results = check_values(mv, numbers, emails, checks)

    counts: Dict[str, int] = {}
    out_header = header + ["verdict", "reachable_on", "suggestion"]
    seen = set()
    with open(dst, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_header)
        writer.writeheader()
        for r in rows:
            key = (r.get(phone_col, "").strip() if phone_col else "") or (r.get(email_col, "").strip() if email_col else "")
            item = results.get(key)
            if key in seen:
                verdict, reachable, hint = "duplicate", [], ""
            elif item is None:
                verdict, reachable, hint = "invalid", [], "empty value"
            else:
                verdict, reachable, hint = row_verdict(item)
            seen.add(key)
            counts[verdict] = counts.get(verdict, 0) + 1
            writer.writerow({**r, "verdict": verdict, "reachable_on": ",".join(reachable), "suggestion": hint})
    return counts


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    checks = ["whatsapp"]
    if "--checks" in argv:
        checks = argv[argv.index("--checks") + 1].split(",")
    try:
        counts = clean(argv[0], argv[1], checks)
    except MobileValidateError as e:
        print(f"{e.code}: {e}", file=sys.stderr)
        if e.suggestion:
            print(f"  Suggestion: {e.suggestion}", file=sys.stderr)
        if e.request_id:
            print(f"  Request ID: {e.request_id}", file=sys.stderr)
        return 1
    print("Wrote", argv[1], counts)  # counts only
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
