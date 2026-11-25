"""The eight common refusals say what to change, in text that stays inside the stored-reason gate."""

from __future__ import annotations

import pytest

from sourcesql import error_codes
from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.providers import ProviderRegistry
from sourcesql.sql.admission import PUBLIC_REASON, admit, public_refusal_reason

from test_engine_lineage import reference_worker


def refused(call) -> SourcesQLError:
    with pytest.raises(SourcesQLError) as error:
        call()
    return error.value


@pytest.fixture
def engine(tmp_path):
    return Engine(tmp_path / "engine", worker=reference_worker)


def test_parse_error_names_line_column_and_token():
    error = refused(lambda: admit("SELEC 1"))
    assert error.code == "invalid_query"
    assert error.safe_message == (
        "SQL could not be parsed in the installed dialect. Line 1, column 7: Unexpected token. "
        "Fix the SQL at that position and run it again."
    )
    assert public_refusal_reason(error) == error.safe_message


def test_parse_error_never_contains_query_text():
    error = refused(lambda: admit("SELECT 'secret_value' FROM WHERE"))
    assert "secret_value" not in error.safe_message
    assert "WHERE" not in error.safe_message
    assert error.safe_message.startswith("SQL could not be parsed in the installed dialect. Line 1")


def test_unknown_column_names_the_column():
    error = refused(lambda: admit("SELECT nope FROM (SELECT 1 AS a) t"))
    assert error.code == "invalid_query"
    assert error.safe_message == (
        "Column is unknown or ambiguous; use an explicit relation alias. Column name: nope. "
        "Check the column names of the relations in FROM, or qualify it as alias.column."
    )
    assert (
        "Column name: t.nope."
        in refused(lambda: admit("SELECT t.nope FROM (SELECT 1 AS a) t")).safe_message
    )


def test_unbound_parameter_names_the_parameter():
    error = refused(lambda: admit("SELECT $missing AS n"))
    assert error.code == "invalid_query"
    assert error.safe_message == (
        "A query parameter has no binding. Parameter name: missing. "
        "Pass a value for missing in parameters, with the same name as in the SQL "
        "but without the dollar sign."
    )


def test_unknown_profile_lists_the_capability_profiles(engine):
    error = refused(lambda: engine.query(query="SELECT 1 AS n", profile="live"))
    assert error.code == "unsupported_capability"
    names = ", ".join(p["name"] for p in engine.capabilities()["profiles"])
    assert error.safe_message == (
        f"Profile unavailable. Requested profile: live. Available profiles: {names}. "
        "Choose one of these, or omit profile to use the default."
    )


def test_a_non_text_profile_leaves_out_the_detail_and_the_step_that_needs_it(engine):
    error = refused(lambda: engine.query(query="SELECT 1 AS n", profile=7))
    assert error.safe_message == "Profile unavailable"


def test_more_than_twelve_profiles_are_cut(tmp_path):
    many = Engine(
        tmp_path / "engine",
        profiles={f"p{i}": {"mode": "fixture"} for i in range(14)},
        worker=reference_worker,
    )
    error = refused(lambda: many.query(query="SELECT 1 AS n", profile="live"))
    assert "p10, and 3 more." in error.safe_message
    assert "p11" not in error.safe_message


def test_fifteen_long_profile_names_fit_the_local_limit_and_are_cut_after_twelve(tmp_path):
    many = Engine(
        tmp_path / "engine",
        profiles={f"research_profile_{i:02}": {"mode": "fixture"} for i in range(14)},
        worker=reference_worker,
    )
    error = refused(lambda: many.query(query="SELECT 1 AS n", profile="absent"))
    assert error.code == "unsupported_capability"
    assert "research_profile_10, and 3 more." in error.safe_message
    assert "research_profile_11" not in error.safe_message
    assert 240 < len(error.safe_message) <= 400
    assert error.safe_message.endswith("or omit profile to use the default.")


@pytest.mark.parametrize(
    ("sql", "name"),
    [
        ('SELECT t."nope" FROM (SELECT 1 AS a) t', "t.nope"),
        ("SELECT t.nope FROM (SELECT 1 AS a) t", "t.nope"),
        ('SELECT "nope" FROM (SELECT 1 AS a) t', "nope"),
        ('SELECT "bad/name" FROM (SELECT 1 AS a) t', "(name omitted)"),
    ],
)
def test_unknown_column_names_the_bare_identifier_quoted_or_not(sql, name):
    assert f"Column name: {name}." in refused(lambda: admit(sql)).safe_message


def test_budget_over_ceiling_names_key_and_max():
    error = refused(lambda: Budget({"max_fetches": 99}))
    assert error.code == "invalid_request"
    assert error.safe_message == (
        "Requested budget exceeds the supported ceiling. "
        "Budget key max_fetches is at most 40; you sent 99. Lower it to 40 or less."
    )


def test_exhausted_allowance_names_counter_and_limit(engine):
    error = refused(
        lambda: engine.query(
            query="SELECT url FROM WEB_FETCH('https://aurora.example/project','https://aurora.example/other')",
            budgets={"max_fetches": 1},
        )
    )
    assert error.code == "budget_exhausted"
    assert error.safe_message == (
        "Work allowance exhausted. The max_fetches allowance of 1 was used up. "
        "Narrow the query, or ask the user to approve a higher limit."
    )


def test_a_limit_already_at_its_ceiling_is_not_called_raisable():
    budget = Budget({"max_fetches": 40})
    error = refused(lambda: [budget.reserve("fetches", limit="max_fetches") for _ in range(41)])
    assert error.safe_message == (
        "Work allowance exhausted. The max_fetches allowance of 40 was used up. Narrow the query."
    )


def live_registry(**changes):
    return ProviderRegistry(
        {
            "mode": "live",
            "provider": "exa",
            "api_key": "synthetic-not-a-provider-key",
            "allow_live": True,
            "approved_cost_microusd": 1000,
            "metering_policy": "estimated",
            **changes,
        }
    )


def test_live_without_per_query_budget_says_what_to_set():
    error = refused(lambda: live_registry()._authorize(Budget()))
    assert error.code == "unauthorized"
    assert error.safe_message == (
        "Live dispatch requires a trusted finite spending grant. "
        "This live request has no per-query cost budget. Approved amount: 1000 microusd. "
        "Set budgets.max_cost_microusd to a positive amount no larger than the profile's "
        "approved amount."
    )


@pytest.mark.parametrize(
    "case",
    [
        {"allow_live": False},
        {"approved_cost_microusd": 0},
    ],
)
def test_an_unauthorised_profile_gets_only_the_fixed_sentence(case):
    error = refused(lambda: live_registry(**case)._authorize(Budget()))
    assert error.safe_message == "Live dispatch requires a trusted finite spending grant"


def test_a_budget_over_the_approved_amount_gets_only_the_fixed_sentence():
    error = refused(lambda: live_registry()._authorize(Budget({"max_cost_microusd": 5000})))
    assert error.safe_message == "Live dispatch requires a trusted finite spending grant"


def test_unsupported_construct_points_to_capabilities():
    error = refused(lambda: admit("SELECT * FROM read_csv('x')"))
    assert error.code == "unsupported_query"
    assert error.safe_message == (
        "Unsupported SQL construct: ReadCSV. "
        "Call sourcesql_capabilities to see the supported operators and constructs."
    )


def test_every_detailed_refusal_passes_the_stored_reason_gate():
    for query in ("SELEC 1", "SELECT nope FROM (SELECT 1 AS a) t", "SELECT $x", "SELECT random()"):
        assert PUBLIC_REASON.fullmatch(refused(lambda: admit(query)).safe_message), query


@pytest.mark.parametrize(
    ("refusal_id", "call"),
    [
        ("parse_error", lambda: admit("SELEC 1")),
        ("unknown_column", lambda: admit("SELECT nope FROM (SELECT 1 AS a) t")),
        ("unbound_parameter", lambda: admit("SELECT $x")),
        ("budget_ceiling", lambda: Budget({"max_fetches": 99})),
        ("unsupported_construct", lambda: admit("SELECT random()")),
    ],
)
def test_each_refusal_raises_the_code_the_table_names(refusal_id, call):
    assert refused(call).code == error_codes.TABLE["refusals"][refusal_id]["code"]


def test_the_other_refusals_raise_the_code_the_table_names(engine):
    table = error_codes.TABLE["refusals"]
    codes = {
        "profile_unavailable": refused(lambda: engine.query(query="SELECT 1 AS n", profile="x")),
        "allowance_exhausted": refused(
            lambda: Budget({"max_fetches": 0}).reserve("fetches", limit="max_fetches")
        ),
        "missing_cost_budget": refused(lambda: live_registry()._authorize(Budget())),
        "search_key_missing": refused(
            lambda: live_registry(api_key="", api_key_env="SYNTHETIC_UNSET_KEY").preflight(
                ["WEB_SEARCH"], Budget({"max_cost_microusd": 1})
            )
        ),
        "fetch_hosts_missing": refused(
            lambda: live_registry().preflight(["WEB_FETCH"], Budget({"max_cost_microusd": 1}))
        ),
    }
    for refusal_id, error in codes.items():
        assert error.code == table[refusal_id]["code"], refusal_id
