import csv
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from clean_list import clean, mask, row_verdict  # noqa: E402

HERE = os.path.dirname(__file__)


def test_row_verdicts():
    ok = {"number_status": "valid", "checks": {"whatsapp.registered": {"registered": True}}}
    unknown = {"number_status": "valid", "checks": {"whatsapp.registered": {"registered": None}}}
    no = {"number_status": "valid", "checks": {"whatsapp.registered": {"registered": False}}}
    bad = {"number_status": "invalid_number", "suggestion": "Add the country code."}
    assert row_verdict(ok) == ("ok", ["whatsapp"], "")
    assert row_verdict(unknown)[0] == "unknown"
    assert row_verdict(no)[0] == "not_reachable"
    assert row_verdict(bad) == ("invalid", [], "Add the country code.")


def test_mask_hides_numbers_and_addresses():
    assert mask("+447700900001") == "+44••••••••01"
    assert mask("registered@test.mobilevalidate.com") == "re•••@test.mobilevalidate.com"


def test_clean_sample_list(tmp_path):
    out = tmp_path / "cleaned.csv"
    counts = clean(os.path.join(HERE, "list.csv"), str(out))
    rows = list(csv.DictReader(open(out, encoding="utf-8")))
    by_name = {r["name"]: r for r in rows}
    assert by_name["Ann"]["verdict"] == "ok" and by_name["Ann"]["reachable_on"] == "whatsapp"
    assert by_name["Ben"]["verdict"] == "not_reachable"
    assert by_name["Cleo"]["verdict"] == "unknown"
    assert by_name["Dan"]["verdict"] == "ok"  # pending, then registered (the SDK waits)
    assert by_name["Eve"]["verdict"] == "duplicate"
    assert by_name["Finn"]["verdict"] == "ok"  # e-mail row
    assert counts["duplicate"] == 1
