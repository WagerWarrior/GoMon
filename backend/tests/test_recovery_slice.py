"""Increment 1 proofs (spec section 5): reconnect stays stale; no approval = no write; ACK without
matching display cannot close; every boundary crosses the router; duplicates are ignored."""
import pytest
from app import engine, simulator
from app.db import db


def ask(inc, turn, text="Can I close this incident?"):
    return engine.handle_turn(inc["_id"], turn, text)


def test_reconnect_does_not_replay_and_answer_names_stale_display(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    assert simulator.read_display(hx101)["status"] == "On time"  # still stale after reconnect
    t = ask(inc, "t1")
    assert "On time from 10:05" in t["response"] and "Delayed from 10:20" in t["response"]
    assert t["response"].startswith("Not yet")
    assert t["state"] == "awaiting_approval"
    assert t["routes"] == ["READ_STATE", "RESPOND_NOW"] and t["reasonerCalls"] == 0
    assert db().commands.count_documents({}) == 0 and db().sim_effects.count_documents({}) == 0


def test_no_approval_no_write_and_voice_cannot_approve(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    t = ask(inc, "t2", "approve the refresh")
    assert "can't approve" in t["response"]
    assert db().sim_effects.count_documents({}) == 0
    with pytest.raises(PermissionError):
        engine.approve(inc["_id"], "sup", "wrong-id")


def test_full_recovery_verified_close(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    ap = engine.get_incident(inc["_id"])["approval"]
    after = engine.approve(inc["_id"], "supervisor-1", ap["approvalId"])
    assert after["state"] == "refresh_pending" and after["command"]["status"] == "acked"
    assert after["approval"]["supervisorId"] == "supervisor-1"
    t = ask(inc, "t2", "verify the refresh")
    assert t["routes"] == ["VERIFY_EFFECT", "RESPOND_NOW"]
    assert t["state"] == "resolved" and "closed" in t["response"]
    assert db().sim_effects.count_documents({"applied": True}) == 1
    res = engine.get_incident(inc["_id"])["resolution"]
    assert len(res["evidenceIds"]) == 2 and res["sourceVersion"] == 2


def test_ack_without_application_cannot_close(hx101):
    simulator.seed_flight("HX101", "Delayed", "10:20", 2, "On time", "10:05", 1, apply_mode="ack_only")
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    engine.approve(inc["_id"], "sup", engine.get_incident(inc["_id"])["approval"]["approvalId"])
    t = ask(inc, "t2", "verify")
    assert t["state"] == "awaiting_approval" and "acknowledgment is not recovery" in t["response"]
    assert engine.get_incident(inc["_id"])["resolution"] is None


def test_display_unavailable_keeps_incident_open(hx101):
    inc = engine.open_incident(hx101)  # connection still down
    t = ask(inc, "t1")
    assert "can't read" in t["response"] and t["state"] == "investigating"


def test_target_change_invalidates_approval(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    ap = engine.get_incident(inc["_id"])["approval"]
    simulator.advance_source(hx101, "Cancelled", "10:40")
    with pytest.raises(PermissionError):
        engine.approve(inc["_id"], "sup", ap["approvalId"])
    assert db().commands.count_documents({}) == 0
    assert engine.get_incident(inc["_id"])["approval"]["status"] == "invalidated"


def test_rejected_approval_prevents_write(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    engine.reject(inc["_id"], "sup", engine.get_incident(inc["_id"])["approval"]["approvalId"])
    assert db().commands.count_documents({}) == 0 and db().sim_effects.count_documents({}) == 0


def test_receiver_dedupes_same_command_id(hx101):
    simulator.reconnect(hx101)
    simulator.send_refresh("cmd-1", hx101)
    assert simulator.send_refresh("cmd-1", hx101)["duplicate"] is True
    assert db().sim_effects.count_documents({"commandId": "cmd-1"}) == 1


def test_duplicate_turn_event_is_not_reprocessed(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    n = db().decisions.count_documents({})
    again = ask(inc, "t1")
    assert again["duplicate"] is True and db().decisions.count_documents({}) == n


def test_unknown_request_goes_to_reasoner_honestly(hx101):
    inc = engine.open_incident(hx101)
    t = ask(inc, "t1", "book me a taxi")
    assert t["routes"] == ["DELEGATE_TO_REASONER"] and t["reasonerCalls"] == 1
    assert "reasoner model" in t["response"]


def test_every_decision_is_persisted_with_router_version(hx101):
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    ask(inc, "t1")
    ds = list(db().decisions.find({"incidentId": inc["_id"]}).sort("step", 1))
    assert [d["route"] for d in ds] == ["READ_STATE", "RESPOND_NOW"]
    assert all(d["classifierVersion"] == "bootstrap-v0" and d["probability"] is None for d in ds)
