import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from email_check import check_signup_email, decide_email  # noqa: E402
from mobilevalidate import TEST_EMAILS  # noqa: E402


def test_decision_table():
    row = lambda reg: {"email_status": "valid", "checks": {"email.valid": {"registered": reg}}}  # noqa: E731
    assert decide_email(row(True))["decision"] == "allow"
    assert decide_email(row(False))["decision"] == "confirm"
    assert decide_email(row(None))["decision"] == "allow"
    assert decide_email({"email_status": "invalid_email", "suggestion": "Did you mean @gmail.com?"})["message"] == "Did you mean @gmail.com?"


def test_test_addresses():
    assert check_signup_email(TEST_EMAILS["registered"])["decision"] == "allow"
    assert check_signup_email(TEST_EMAILS["not_registered"])["decision"] == "confirm"
    assert check_signup_email(TEST_EMAILS["unknown"])["decision"] == "allow"
