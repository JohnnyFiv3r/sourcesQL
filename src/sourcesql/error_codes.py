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
_SLOT = re.compile(r"\{([a-z_]+)\}")
_NAME = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_SLOT_TYPES = frozenset({"int", "name", "names", "enum"})
_OMITTED = "(name omitted)"
_MAX_NAMES = 12
_MAX_LENGTH = 240


def _validate_refusals(codes: dict, refusals: object) -> None:
    """Each refusal template must render inside the stored-reason gate."""
    if not isinstance(refusals, dict):
        raise ValueError("error_codes.json refusals must be an object")
    for refusal_id, entry in refusals.items():
        if not isinstance(entry, dict) or entry.get("code") not in codes:
            raise ValueError(f"error_codes.json refusal has an unknown code: {refusal_id}")
        slots = entry.get("slots", {})
        if not isinstance(slots, dict) or not set(slots.values()) <= _SLOT_TYPES:
            raise ValueError(f"error_codes.json refusal has a bad slot type: {refusal_id}")
        values = entry.get("values", {})
        for slot, kind in slots.items():
            if kind == "enum" and not (
                isinstance(values.get(slot), list)
                and values[slot]
                and all(isinstance(v, str) and _SUMMARY.match(v) for v in values[slot])
            ):
                raise ValueError(f"error_codes.json refusal enum has no values: {refusal_id}")
        for field in ("message", "detail", "hint", "hint_raisable"):
            if field not in entry:
                if field == "message":
                    raise ValueError(f"error_codes.json refusal has no message: {refusal_id}")
                continue
            text = entry[field]
            if not isinstance(text, str):
                raise ValueError(f"error_codes.json refusal {field} is not text: {refusal_id}")
            if not set(_SLOT.findall(text)) <= set(slots):
                raise ValueError(f"error_codes.json refusal uses an undeclared slot: {refusal_id}")
            if not _SUMMARY.match(_SLOT.sub("x", text)):
                raise ValueError(
                    f"error_codes.json refusal {field} fails the text gate: {refusal_id}"
                )


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
    _validate_refusals(codes, table.get("refusals"))
    return table


TABLE = _load()
CODES = frozenset(TABLE["codes"])
HOSTED_CODES = frozenset(code for code, entry in TABLE["codes"].items() if entry["hosted_visible"])


def summary(code: str) -> str:
    return TABLE["codes"][code]["summary"]


def _slot_text(kind: str, value: object, allowed: list[str] | None) -> str | None:
    """A slot's text, or None when it is not available. Anything unsafe is replaced, never passed."""
    if value is None:
        return None
    if kind == "int":
        if type(value) is not int:
            raise TypeError("an int slot needs an int")
        return str(value)
    if kind == "enum":
        if isinstance(value, str) and allowed and value in allowed:
            return value
        return allowed[-1] if allowed else None
    if kind == "name":
        return value if isinstance(value, str) and _NAME.match(value) else _OMITTED
    if not isinstance(value, list | tuple):
        raise TypeError("a names slot needs a list")
    names = [v if isinstance(v, str) and _NAME.match(v) else _OMITTED for v in value]
    if len(names) > _MAX_NAMES:
        return ", ".join(names[:_MAX_NAMES]) + f", and {len(names) - _MAX_NAMES} more"
    return ", ".join(names) if names else None


def refusal(refusal_id: str, /, *, raisable: bool = False, **slots: object) -> str:
    """The message for one refusal: its fixed sentence, then detail and a next step.

    Detail comes only from typed slots, so it cannot carry free text. When a slot is not
    available the detail and the step that points at it are left out and the fixed sentence
    stands alone. The result is always inside the stored-reason gate and 240 characters.
    """
    entry = TABLE["refusals"][refusal_id]
    kinds = entry.get("slots", {})
    values = entry.get("values", {})
    if set(slots) - set(kinds):
        raise ValueError(f"unknown slot for refusal {refusal_id}")
    text = {
        name: _slot_text(kind, slots.get(name), values.get(name)) for name, kind in kinds.items()
    }

    def fill(template: str) -> str | None:
        if any(text[name] is None for name in _SLOT.findall(template)):
            return None
        return _SLOT.sub(lambda m: text[m.group(1)] or "", template)

    # A name inside the fixed sentence has no sentence to fall back to.
    message = _SLOT.sub(lambda m: text[m.group(1)] or _OMITTED, entry["message"])
    detail = fill(entry["detail"]) if "detail" in entry else None
    hint_template = (
        entry.get("hint_raisable") if raisable and "hint_raisable" in entry else entry.get("hint")
    )
    hint = fill(hint_template) if hint_template else None
    if "detail" in entry and detail is None:
        hint = None

    def assemble(*parts: str | None) -> str:
        first, *rest = [part for part in parts if part]
        return " ".join([first if first.endswith(".") else first + ".", *rest]) if rest else first

    for candidate in (assemble(message, detail, hint), assemble(message, detail), message):
        if len(candidate) <= _MAX_LENGTH:
            break
    if not _SUMMARY.fullmatch(candidate):
        raise ValueError(f"refusal {refusal_id} rendered outside the text gate")
    return candidate
