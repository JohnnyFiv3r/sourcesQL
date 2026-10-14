"""Shared engine/provider/planner contracts. Coordinator-owned."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable
import hashlib
import json
import threading


class WebQLError(Exception):
    def __init__(self, code: str, message: str, stage: str = "admission"):
        super().__init__(message)
        self.code, self.safe_message, self.stage = code, message, stage


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass(frozen=True)
class Column:
    key: str
    logical_type: str = "VARCHAR"
    nullable: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.key,
            "logical_type": self.logical_type,
            "nullable": self.nullable,
        }


@dataclass
class Table:
    columns: list[Column]
    rows: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {"columns": [c.to_dict() for c in self.columns], "rows": self.rows}


@dataclass
class SemanticOutcome:
    value: Any
    status: str
    support: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)


DEFAULT_LIMITS = {
    "max_search_queries": 8,
    "max_search_requests": 16,
    "max_candidates": 200,
    "max_fetches": 40,
    "max_semantic_documents": 40,
    "max_model_requests": 96,
    "max_concurrency": 4,
    "dispatch_deadline_seconds": 180,
    "max_output_rows": 1000,
    "max_output_bytes": 4194304,
    "max_input_tokens": 200000,
    "max_output_tokens": 16000,
    "max_cost_microusd": 0,
}


class Budget:
    """One shared allowance for the whole run. Provider attempts reserve before dispatch."""

    def __init__(
        self,
        limits: dict[str, Any] | None = None,
        on_reserve: Callable[[str, int], None] | None = None,
    ):
        self.limits = dict(DEFAULT_LIMITS)
        for key, value in (limits or {}).items():
            if key not in self.limits or type(value) is not int or value < 0:
                raise WebQLError("invalid_request", "Invalid budget")
            if key != "max_cost_microusd" and value > DEFAULT_LIMITS[key]:
                raise WebQLError("invalid_request", "Requested budget exceeds v0.1 ceiling")
            self.limits[key] = value
        self.counts: dict[str, int] = {}
        self.lock = threading.Lock()
        self.cancelled = False
        self.on_reserve = on_reserve

    def reserve(self, counter: str, amount: int = 1, limit: str | None = None) -> None:
        with self.lock:
            if self.cancelled:
                raise WebQLError("cancelled", "Run cancelled", "dispatch")
            cap = self.limits.get(limit or "max_" + counter)
            value = self.counts.get(counter, 0) + amount
            if cap is not None and value > cap:
                raise WebQLError("budget_exhausted", "Work allowance exhausted", "dispatch")
            self.counts[counter] = value
            observer = self.on_reserve
        # Persistence/authorization observers finish before the caller can dispatch.
        # Exceptions propagate; the reserved allowance remains conservatively consumed.
        if observer is not None:
            observer(counter, amount)
