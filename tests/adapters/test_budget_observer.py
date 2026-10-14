"""Reservation observation is synchronous, outside the lock and before dispatch."""

import pytest

from open_webql.contracts import Budget, WebQLError


def test_observer_records_successful_reservation_before_effect_outside_lock():
    events = []

    def observer(counter, amount):
        assert budget.counts[counter] == amount
        assert budget.lock.acquire(blocking=False)
        budget.lock.release()
        events.append(("durable_intent", counter, amount))

    budget = Budget(on_reserve=observer)
    budget.reserve("model_requests", 2, "max_model_requests")
    events.append(("fake_effect", "model_requests", 2))
    assert events == [("durable_intent", "model_requests", 2), ("fake_effect", "model_requests", 2)]


def test_exhausted_allowance_notifies_no_observer_and_performs_no_effect():
    events = []
    budget = Budget({"max_model_requests": 0}, on_reserve=lambda *args: events.append(args))

    def dispatch():
        budget.reserve("model_requests", limit="max_model_requests")
        events.append("fake_effect")

    with pytest.raises(WebQLError) as error:
        dispatch()
    assert error.value.code == "budget_exhausted"
    assert events == [] and budget.counts == {}
