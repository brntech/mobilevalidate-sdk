import re
from pathlib import Path

import pytest

import mobilevalidate as m

SHARED = Path(__file__).resolve().parents[2] / "shared" / "src" / "sandbox.ts"
CONTRACT = Path(__file__).resolve().parents[2] / "shared" / "src" / "contract.ts"
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_sandbox_key_format():
    assert re.fullmatch(r"mv_test_[0-9A-Za-z]{36}", m.SANDBOX_PUBLIC_KEY)


@pytest.mark.skipif(not SHARED.exists(), reason="monorepo shared package not present")
def test_sandbox_key_matches_shared_source():
    src = SHARED.read_text()
    assert re.search(r'SANDBOX_PUBLIC_KEY\s*=\s*"([^"]+)"', src).group(1) == m.SANDBOX_PUBLIC_KEY
    assert f"perMinute: {m.SANDBOX_LIMITS['per_minute']}" in src
    assert f"maxJobRows: {m.SANDBOX_LIMITS['max_job_rows']}" in src


@pytest.mark.skipif(not CONTRACT.exists(), reason="monorepo shared package not present")
def test_magic_numbers_match_contract():
    block = CONTRACT.read_text().split("TEST_MAGIC", 1)[1]
    assert set(re.findall(r'"(\+447700900\d{3})"', block)) == set(m.TEST_NUMBERS.values())


@pytest.mark.skipif(not CONTRACT.exists(), reason="monorepo shared package not present")
def test_error_codes_match_contract():
    src = CONTRACT.read_text().split("export const ERROR_CODES", 1)[1].split("} as const", 1)[0]
    codes = set(re.findall(r"^\s*([a-z_]+): \{ status", src, re.M))
    from mobilevalidate._errors import ERROR_CLASSES
    missing = codes - set(ERROR_CLASSES)
    assert not missing, f"no error class for {missing}"


def test_version_matches_pyproject():
    assert f'version = "{m.__version__}"' in PYPROJECT.read_text()
