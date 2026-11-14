"""Turn engine: classify -> gate -> execute -> persist, repeated until a response, a bounded driver step,
or the step budget. MongoDB holds every fact; the engine keeps no state of its own between calls.
"""
import threading
import time
import uuid

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from . import classifier, driver, policy, responses, simulator
from .db import db, now_ms

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(incident_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(incident_id, threading.Lock())


# ---------- incidents ----------

def open_incident(flight_id: str) -> dict:
    inc = {"_id": f"INC-{uuid.uuid4().hex[:8]}", "flightId": flight_id, "state": "investigating", "revision": 0,
           "approval": None, "command": None, "resolution": None, "commandSeq": 0, "createdAt": now_ms(),
           "classifierVersion": classifier.VERSION, "label": simulator.LABEL}
    db().incidents.insert_one(inc)
    return inc


def get_incident(incident_id: str) -> dict:
    inc = db().incidents.find_one({"_id": incident_id})
    if not inc:
        raise KeyError(incident_id)
    return inc


def _update(inc: dict, expected_rev: int, fields: dict) -> dict:
    """Optimistic update: only applies if the incident revision is unchanged."""
    r = db().incidents.find_one_and_update({"_id": inc["_id"], "revision": expected_rev},
                                           {"$set": fields, "$inc": {"revision": 1}},
                                           return_document=ReturnDocument.AFTER)
    if r is None:
        raise RuntimeError("revision_conflict")
    return r


# ---------- evidence ----------

def observe(inc: dict) -> tuple[dict, dict]:
    """Read both systems and persist both observations (separate records, with source time != observed time)."""
    fid = inc["flightId"]
    out = []
    for system, row in (("source", simulator.read_source(fid)), ("display", simulator.read_display(fid))):
        o = {"incidentId": inc["_id"], "system": system, "flightId": fid, "observedAt": now_ms(),
             "available": row is not None, "label": simulator.LABEL}
        if row is not None:
            o.update(flightId=row["flightId"], status=row["status"], sourceTime=row["sourceTime"],
                     sourceVersion=row["sourceVersion"])
        db().observations.insert_one(o)
        o["_id"] = str(o["_id"])
        out.append(o)
    return out[0], out[1]


def _snapshot(inc: dict, intent: str, read_ids: list, driver_calls: int) -> dict:
    cmd = inc.get("command")
    return {"incidentId": inc["_id"], "revision": inc["revision"], "state": inc["state"], "intent": intent,
            "readThisTurn": bool(read_ids), "evidenceIds": read_ids, "driverCalls": driver_calls,
            "commandAcked": bool(cmd and cmd["status"] == "acked" and inc["state"] == "refresh_pending")}


# ---------- approval / command (server-enforced; the classifier can never reach these) ----------

def _request_approval(inc: dict, src: dict) -> dict:
    ap = inc.get("approval")
    if inc["state"] == "awaiting_approval" and ap and ap["status"] == "pending" \
            and ap["sourceVersion"] == src["sourceVersion"]:
        return inc
    approval = {"approvalId": uuid.uuid4().hex[:10], "status": "pending", "flightId": inc["flightId"],
                "action": "refresh_display", "sourceVersion": src["sourceVersion"], "requestedAt": now_ms(),
                "expiresAt": now_ms() + policy.APPROVAL_TTL_MS, "supervisor": None}
    return _update(inc, inc["revision"], {"state": "awaiting_approval", "approval": approval})


def approve(incident_id: str, supervisor: str, approval_id: str) -> dict:
    """Validated UI approval event. Records approval BEFORE the command is sent; binds to exact target version."""
    with _lock(incident_id):
        inc = get_incident(incident_id)
        ap = inc.get("approval")
        if inc["state"] != "awaiting_approval" or not ap or ap["status"] != "pending" or ap["approvalId"] != approval_id:
            raise PermissionError("no_matching_pending_approval")
        src = simulator.read_source(inc["flightId"])
        if now_ms() > ap["expiresAt"] or src["sourceVersion"] != ap["sourceVersion"]:
            ap = {**ap, "status": "invalidated", "reason": "expired_or_target_changed"}
            _update(inc, inc["revision"], {"state": "investigating", "approval": ap})
            raise PermissionError("approval_invalidated_ask_again")
        seq = inc["commandSeq"] + 1
        command = {"commandId": f"{inc['_id']}:refresh:{seq}", "incidentId": inc["_id"], "flightId": inc["flightId"],
                   "action": "refresh_display", "sourceVersion": ap["sourceVersion"], "approvalId": approval_id,
                   "status": "intent", "intentAt": now_ms(), "ackAt": None, "label": simulator.LABEL}
        db().commands.insert_one(dict(command))  # intent persisted before sending
        ap = {**ap, "status": "approved", "supervisor": supervisor, "approvedAt": now_ms()}
        inc = _update(inc, inc["revision"], {"state": "refresh_pending", "approval": ap, "commandSeq": seq,
                                             "command": command})
        ack = simulator.send_refresh(command["commandId"], inc["flightId"])
        if ack.get("ack"):
            upd = {"status": "acked", "ackAt": now_ms()}
        else:
            upd = {"status": "ambiguous", "ackReason": ack.get("reason")}  # no ACK does not prove failure
        db().commands.update_one({"commandId": command["commandId"]}, {"$set": upd})
        inc = _update(inc, inc["revision"], {"command": {**command, **upd}})
        return inc


def reject(incident_id: str, supervisor: str, approval_id: str) -> dict:
    with _lock(incident_id):
        inc = get_incident(incident_id)
        ap = inc.get("approval")
        if inc["state"] != "awaiting_approval" or not ap or ap["approvalId"] != approval_id:
            raise PermissionError("no_matching_pending_approval")
        ap = {**ap, "status": "rejected", "supervisor": supervisor, "decidedAt": now_ms()}
        return _update(inc, inc["revision"], {"state": "investigating", "approval": ap})  # no write


# ---------- turn loop ----------

def _record_decision(inc, turn_id, step, d, override, snap, started):
    db().decisions.insert_one({
        "incidentId": inc["_id"], "turnId": turn_id, "step": step, "route": d.route, "reason": d.reason,
        "classifierVersion": d.classifier_version, "probability": d.probability, "evidenceIds": snap["evidenceIds"],
        "gateOverride": override, "snapshot": {k: snap[k] for k in ("revision", "state", "intent", "readThisTurn",
                                                                      "commandAcked", "driverCalls")},
        "at": now_ms(), "latencyMs": round((time.perf_counter() - started) * 1000, 3)})


def _respond(inc: dict, intent: str, reason: str, src, disp) -> tuple[str, dict]:
    """Render an approved template from observed facts; apply deterministic state transitions."""
    fid = inc["flightId"]
    if reason == "approval_is_ui_only":
        return responses.render("approval_is_ui_only", fid, None, None), inc
    if not (src and src["available"]):
        return responses.render("unavailable", fid, src, disp, {"system": "airline feed"}), inc
    if not (disp and disp["available"]):
        return responses.render("unavailable", fid, src, disp, {"system": "airport display"}), inc
    ok, why = policy.can_close(src, disp, inc.get("command") if inc["state"] == "refresh_pending" else None, fid)
    if intent == "status_query":
        return responses.render("status", fid, src, disp), inc
    if ok:
        had_cmd = inc["state"] == "refresh_pending"
        resolution = {"verifiedAt": now_ms(), "sourceVersion": src["sourceVersion"], "evidenceIds":
                      [src["_id"], disp["_id"]], "commandId": inc["command"]["commandId"] if had_cmd else None}
        inc = _update(inc, inc["revision"], {"state": "resolved", "resolution": resolution})
        return responses.render("closed_verified" if had_cmd else "consistent", fid, src, disp), inc
    if why == "mismatch":
        after = inc["state"] == "refresh_pending"
        if after:  # ACK without application: command effect is not recovery
            db().commands.update_one({"commandId": inc["command"]["commandId"]}, {"$set": {"status": "acked_not_applied"}})
            inc = _update(inc, inc["revision"], {"state": "investigating",
                                                 "command": {**inc["command"], "status": "acked_not_applied"}})
        inc = _request_approval(inc, src)
        return responses.render("mismatch_after_refresh" if after else "mismatch", fid, src, disp), inc
    return responses.render("unavailable", fid, src, disp), inc


def handle_turn(incident_id: str, turn_id: str, text: str) -> dict:
    """One committed transcript/text turn. Deduplicated by (incidentId, turnId); serialized per incident."""
    with _lock(incident_id):
        existing = db().turns.find_one({"incidentId": incident_id, "turnId": turn_id})
        if existing:
            existing.pop("_id", None)
            return {**existing, "duplicate": True}
        t0 = time.perf_counter()
        inc = get_incident(incident_id)
        intent = classifier.intent_of(text)
        turn = {"incidentId": incident_id, "turnId": turn_id, "text": text, "intent": intent, "startedAt": now_ms()}
        try:
            db().turns.insert_one(dict(turn))
        except DuplicateKeyError:
            return {"error": "duplicate_in_flight"}
        tool_order, route_trail, driver_calls = [], [], 0
        src = disp = None
        read_ids: list = []
        response = None
        for step in range(policy.MAX_STEPS):
            started = time.perf_counter()
            inc = get_incident(incident_id)  # reload: revision may have changed
            snap = _snapshot(inc, intent, read_ids, driver_calls)
            d, override = policy.gate(classifier.classify(snap), snap)
            _record_decision(inc, turn_id, step, d, override, snap, started)
            route_trail.append(d.route)
            if d.route in ("READ_STATE", "VERIFY_EFFECT"):
                tool_order.append(d.route.lower())
                src, disp = observe(inc)
                read_ids = [src["_id"], disp["_id"]]
                continue
            if d.route == "DELEGATE_TO_DRIVER":
                driver_calls += 1
                tool_order.append("driver")
                response = responses.render("driver_unavailable", inc["flightId"], None, None) \
                    if driver.propose(inc, text) is None else None
                break
            if d.route == "RESPOND_NOW":
                fresh = get_incident(incident_id)
                if fresh["revision"] != inc["revision"]:
                    continue  # state moved before rendering: reclassify
                response, inc = _respond(inc, intent, d.reason, src, disp)
                break
        if response is None:
            response = responses.render("budget", inc["flightId"], None, None)
        inc = get_incident(incident_id)
        done = {"response": response, "routes": route_trail, "toolOrder": tool_order, "driverCalls": driver_calls,
                "state": inc["state"], "latencyMs": round((time.perf_counter() - t0) * 1000, 3),
                "evidenceIds": read_ids, "completedAt": now_ms(), "status": "complete"}
        db().turns.update_one({"incidentId": incident_id, "turnId": turn_id}, {"$set": done})
        return {**turn, **done, "duplicate": False}
