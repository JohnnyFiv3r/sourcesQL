"""The one list of error codes and their fixed public summaries.

Python allowlists derive from it; the app's hosted-job allowlist is held equal
to it by a test, so the two sides cannot drift unnoticed.
"""

from __future__ import annotations

from importlib.resources import files
import json
import re

_CODE = re.compile(r"[a-z_]{1,40}\Z")
# The same bounded plain-text gate that stored refusal reasons pass.
_SUMMARY = re.compile(r"[A-Za-z0-9 ,.;:()_'-]{1,240}\Z")


def _load() -> dict:
    table = json.loads(files("sourcesql").joinpath("error_codes.json").read_text("utf-8"))
    codes = table.get("codes")
    if table.get("version") != 1 or not isinstance(codes, dict) or not codes:
        raise ValueError("error_codes.json has an unsupported shape")
    for code, entry in codes.items():
        if not _CODE.match(code):
            raise ValueError(f"error_codes.json code is malformed: {code!r}")
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("summary"), str)
            or not _SUMMARY.match(entry["summary"])
            or not isinstance(entry.get("hosted_visible"), bool)
        ):
            raise ValueError(f"error_codes.json entry is malformed: {code}")
    if "execution_failed" not in codes:
        raise ValueError("error_codes.json must define execution_failed")
    return table


TABLE = _load()
CODES = frozenset(TABLE["codes"])
HOSTED_CODES = frozenset(code for code, entry in TABLE["codes"].items() if entry["hosted_visible"])


def summary(code: str) -> str:
    return TABLE["codes"][code]["summary"]
