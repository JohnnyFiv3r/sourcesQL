"""Nesting too deep to parse is refused at admission like the post-parse depth limit."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from sourcesql.contracts import Column, SourcesQLError
from sourcesql.sql.admission import admit, validate_type

DEPTH_REFUSAL = "Query exceeds the AST depth limit"
TYPE_REFUSAL = "Logical type exceeds the supported nesting"

# shape -> (builder, deepest admitted depth, first refused depth)
SHAPES = {
    "parens": (lambda n: "SELECT " + "(" * n + "1" + ")" * n + " AS x", 38, 39),
    "functions": (lambda n: "SELECT " + "abs(" * n + "1" + ")" * n + " AS x", 38, 39),
    "case": (
        lambda n: "SELECT " + "CASE WHEN 1=1 THEN " * n + "1" + " END" * n + " AS x",
        18,
        19,
    ),
    "exists": (
        lambda n: "SELECT 1 AS x WHERE " + "EXISTS (SELECT 1 WHERE " * n + "TRUE" + ")" * n,
        12,
        13,
    ),
    "arrays": (lambda n: "SELECT " + "[" * n + "1" + "]" * n + " AS x", 38, 39),
    "not": (lambda n: "SELECT " + "NOT " * n + "TRUE AS x", 38, 39),
    "minus": (lambda n: "SELECT " + "- " * n + "1 AS x", 38, 39),
    "derived": (
        lambda n: (
            "SELECT x FROM "
            + "(SELECT x FROM " * n
            + "(SELECT 1 AS x) AS t"
            + "".join(f") AS u{i}" for i in range(n))
        ),
        11,
        12,
    ),
}


def depths(first_refused):
    return list(range(first_refused, 100)) + list(range(100, 601, 10))


def assert_clean(message):
    for fragment in ("ecursion", "Traceback", "/", ".py", "_parse"):
        assert fragment not in message, message


def sweep(shape):
    build, _, first_refused = SHAPES[shape]
    slowest = 0.0
    for depth in depths(first_refused):
        started = time.perf_counter()
        with pytest.raises(SourcesQLError) as error:
            admit(build(depth))
        slowest = max(slowest, time.perf_counter() - started)
        assert error.value.code == "invalid_query", (shape, depth)
        assert error.value.safe_message == DEPTH_REFUSAL, (shape, depth)
        assert_clean(error.value.safe_message)
    return slowest


@pytest.mark.parametrize("shape", SHAPES)
def test_too_deep_nesting_is_refused_for_every_shape(shape):
    slowest = sweep(shape)
    print(f"{shape}: slowest refusal {slowest:.3f}s")
    assert slowest < 1.0, f"{shape} took {slowest:.3f}s to refuse"


@pytest.mark.parametrize("shape", SHAPES)
def test_too_deep_nesting_is_refused_inside_a_worker_thread(shape):
    # The bridge runs requests on a ThreadPoolExecutor worker.
    with ThreadPoolExecutor(max_workers=1) as executor:
        slowest = executor.submit(sweep, shape).result()
    assert slowest < 1.0, f"{shape} took {slowest:.3f}s to refuse in a worker"


def in_fresh_thread(function):
    # Under pytest the test body already sits about 33 frames deep, which is enough to
    # make deep nested functions fail to parse sooner than they do at the top level. A
    # fresh thread has the stack the boundary was measured with.
    outcome = {}

    def run():
        try:
            outcome["value"] = function()
        except BaseException as error:
            outcome["error"] = error

    thread = threading.Thread(target=run)
    thread.start()
    thread.join()
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


@pytest.mark.parametrize("shape", SHAPES)
def test_nesting_boundary_is_unchanged(shape):
    build, deepest_admitted, first_refused = SHAPES[shape]

    def probe():
        admit(build(deepest_admitted))
        with pytest.raises(SourcesQLError) as error:
            admit(build(first_refused))
        return error.value

    refusal = in_fresh_thread(probe)
    assert refusal.code == "invalid_query"
    assert refusal.safe_message == DEPTH_REFUSAL


def test_deeply_nested_parentheses_are_refused_not_crashed():
    with pytest.raises(SourcesQLError) as error:
        admit(SHAPES["parens"][0](100))
    assert (error.value.code, error.value.safe_message) == ("invalid_query", DEPTH_REFUSAL)


def struct(depth):
    return "STRUCT(a " * depth + "INTEGER" + ")" * depth


@pytest.mark.parametrize("depth", [9, 50, 300])
def test_too_deep_struct_type_is_refused(depth):
    with pytest.raises(SourcesQLError) as error:
        validate_type(struct(depth))
    assert error.value.code == "invalid_output"
    assert error.value.safe_message == TYPE_REFUSAL
    assert_clean(error.value.safe_message)


def test_struct_type_past_the_length_cap_is_refused_for_its_nesting():
    # 10,007 characters: the length cap would otherwise hide the real reason.
    with pytest.raises(SourcesQLError) as error:
        validate_type(struct(1000))
    assert (error.value.code, error.value.safe_message) == ("invalid_output", TYPE_REFUSAL)
    assert_clean(error.value.safe_message)


def test_long_shallow_type_past_the_length_cap_keeps_its_existing_refusal():
    wide = "STRUCT(" + ", ".join(f"f{i} INTEGER" for i in range(1000)) + ")"
    assert len(wide) > 4096
    with pytest.raises(SourcesQLError) as error:
        validate_type(wide)
    assert (error.value.code, error.value.safe_message) == (
        "invalid_output",
        "Invalid logical type",
    )


def test_too_deep_declared_input_type_is_refused_at_admission():
    schemas = {"t": [Column("c", struct(300), True)]}
    with pytest.raises(SourcesQLError) as error:
        admit("SELECT c FROM input.t", input_schemas=schemas)
    assert (error.value.code, error.value.safe_message) == ("invalid_output", TYPE_REFUSAL)
