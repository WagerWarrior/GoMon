"""MongoDB itself must refuse bad writes (spec section 2, rules 1-3). Each rule gets writes that bypass the engine
and go straight to the database, including missing-field cases, plus a positive control that the same write
is ACCEPTED when the evidence is valid (a validator that rejects everything would prove nothing)."""
from datetime import datetime, timedelta, timezone

import pytest
from pymongo.errors import DuplicateKeyError, WriteError

from app import engine, simulator
from app.db import db


def _pending(hx101, mode="applies"):
    """Real incident driven to refresh_pending through the engine."""
    if mode != "applies":
        simulator.seed_flight("HX101", "Delayed", "10:20", 2, "On time", "10:05", 1, apply_mode=mode)
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    engine.handle_turn(inc["_id"], "t1", "Can I close this incident?")
    engine.approve(inc["_id"], "sup", engine.get_incident(inc["_id"])["approval"]["approvalId"])
    return engine.get_incident(inc["_id"])


def _set(iid, fields):
    return db().incidents.update_one({"_id": iid}, {"$set": fields})


def _good_verification(inc):
    t = inc["target"]
    return {"observationId": "x", "flightId": t["flightId"], "displayStatus": t["status"],
            "displayVersion": t["sourceVersion"], "displaySourceTime": t["sourceTime"],
            "observedAt": inc["command"]["sentAt"] + timedelta(seconds=1)}


def test_rule1_refresh_state_without_approval_is_rejected(hx101):
    inc = engine.open_incident(hx101)
    with pytest.raises(WriteError) as e:
        _set(inc["_id"], {"state": "refresh_pending"})
    assert e.value.code == 121


def test_rule1_missing_supervisor_or_missing_version_is_rejected(hx101):
    inc = engine.open_incident(hx101)
    v = inc["target"]["sourceVersion"]
    for approval in ({"sourceVersion": v},                       # no supervisorId at all
                     {"supervisorId": "s"},                      # no sourceVersion at all
                     {"supervisorId": "s", "sourceVersion": v + 1},  # stale version
                     {"supervisorId": 7, "sourceVersion": v}):   # wrong type
        with pytest.raises(WriteError):
            _set(inc["_id"], {"state": "refresh_pending", "approval": approval})


def test_rule1_positive_control_valid_approval_is_accepted(hx101):
    inc = engine.open_incident(hx101)
    r = _set(inc["_id"], {"state": "refresh_pending",
                          "approval": {"supervisorId": "s", "sourceVersion": inc["target"]["sourceVersion"]}})
    assert r.modified_count == 1


def test_rule2_close_without_verification_is_rejected(hx101):
    inc = _pending(hx101)
    with pytest.raises(WriteError):
        _set(inc["_id"], {"state": "resolved"})


def test_rule2_ack_only_cannot_be_closed_with_the_stale_display(hx101):
    inc = _pending(hx101, mode="ack_only")
    assert inc["command"]["status"] == "acked"
    stale = simulator.read_display(hx101)  # what the display really shows after the ACK
    v = {**_good_verification(inc), "displayStatus": stale["status"], "displayVersion": stale["sourceVersion"],
         "displaySourceTime": stale["sourceTime"]}
    with pytest.raises(WriteError):
        _set(inc["_id"], {"state": "resolved", "verification": v})


def test_rule2_read_before_the_command_or_wrong_field_is_rejected(hx101):
    inc = _pending(hx101)
    good = _good_verification(inc)
    bad_time = {**good, "observedAt": inc["command"]["sentAt"] - timedelta(seconds=1)}
    equal_time = {**good, "observedAt": inc["command"]["sentAt"]}
    no_date = {k: v for k, v in good.items() if k != "observedAt"}
    wrong_flight = {**good, "flightId": "HX999"}
    wrong_ver = {**good, "displayVersion": good["displayVersion"] - 1}
    wrong_time = {**good, "displaySourceTime": "09:00"}
    for v in (bad_time, equal_time, no_date, wrong_flight, wrong_ver, wrong_time):
        with pytest.raises(WriteError):
            _set(inc["_id"], {"state": "resolved", "verification": v})


def test_rule2_positive_control_matching_post_command_read_is_accepted(hx101):
    inc = _pending(hx101)
    r = _set(inc["_id"], {"state": "resolved", "verification": _good_verification(inc)})
    assert r.modified_count == 1


def test_rule3_duplicate_effect_is_a_duplicate_key_error(hx101):
    simulator.reconnect(hx101)
    simulator.send_refresh("cmd-x", hx101)
    with pytest.raises(DuplicateKeyError):
        db().sim_effects.insert_one({"commandId": "cmd-x", "flightId": hx101, "applied": True})


def test_engine_surfaces_a_mongodb_rejection_honestly(hx101, monkeypatch):
    """If the stored evidence were ever inconsistent, the incident must stay open and the refusal be audited."""
    inc = _pending(hx101)
    orig = engine._dt
    monkeypatch.setattr(engine, "_dt", lambda ms: orig(ms) - timedelta(days=1))  # corrupt observedAt: before sentAt
    t = engine.handle_turn(inc["_id"], "t2", "verify the refresh")
    assert engine.get_incident(inc["_id"])["state"] == "refresh_pending" and "MongoDB refused" in t["response"]
    assert db().audit_events.count_documents({"incidentId": inc["_id"], "kind": "rejected_by_mongodb"}) == 1


@pytest.mark.parametrize("kind", ["refresh_without_approval", "close_without_evidence", "close_on_ack_only"])
def test_tamper_api_is_refused_by_mongodb_and_leaves_incident_untouched(hx101, kind):
    inc = _pending(hx101, mode="ack_only")
    before = engine.get_incident(inc["_id"])
    r = engine.tamper(inc["_id"], kind)
    assert r["refused"] is True and r["code"] == 121 and r["rule"]
    after = engine.get_incident(inc["_id"])
    assert after["state"] == before["state"] and after["revision"] == before["revision"]


def test_tamper_duplicate_effect_is_refused_by_unique_index(hx101):
    inc = _pending(hx101)
    r = engine.tamper(inc["_id"], "duplicate_effect")
    assert r["refused"] is True and r["rule"].startswith("rule 3")
    assert db().sim_effects.count_documents({}) == 1


@pytest.mark.parametrize("kind", ["refresh_without_approval", "close_without_evidence"])
def test_tamper_is_refused_even_after_a_legitimate_close(hx101, kind):
    """Regression: the demo tampers AFTER recovery. A payload that is valid in that state (e.g. state=resolved
    again) is a no-op, not a test of the rules, and must never be reported as an accepted forbidden write."""
    inc = _pending(hx101)
    engine.handle_turn(inc["_id"], "v", "verify the refresh")
    assert engine.get_incident(inc["_id"])["state"] == "resolved"
    r = engine.tamper(inc["_id"], kind)
    assert r["refused"] is True and r["code"] == 121
    assert engine.get_incident(inc["_id"])["state"] == "resolved"
    assert db().audit_events.count_documents({"kind": "tamper_ACCEPTED"}) == 0


def test_tamper_that_would_be_legitimate_is_a_labeled_noop_not_an_accepted_hole(hx101):
    inc = _pending(hx101)
    engine.handle_turn(inc["_id"], "v", "verify the refresh")  # display now matches target
    r = engine.tamper(inc["_id"], "close_on_ack_only")
    assert r["refused"] is False and r.get("noop") is True
    assert db().audit_events.count_documents({"kind": "tamper_ACCEPTED"}) == 0
