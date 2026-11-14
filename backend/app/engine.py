"""Turn engine: classify -> gate -> execute -> persist, repeated until a response, a bounded reasoner step,
or the step budget. MongoDB holds every fact; the engine keeps no state of its own between calls.
"""
import threading
import time
import uuid
from datetime import datetime, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure

from . import classifier, reasoner, policy, responses, simulator
from .db import db, now_ms

_routers: dict = {}


def active_version() -> str:
    """The promoted classifier release for NEW sessions; bootstrap if none has passed the gate."""
    rel = db().classifier_releases.find_one({"status": "active"}, {"_id": 1})
    return rel["_id"] if rel else classifier.VERSION


def _route(version: str, snap: dict):
    """Pinned release for this incident. A trained release is loaded from MongoDB (immutable record)."""
    if version == classifier.VERSION:
        return classifier.classify(snap)
    if version not in _routers:
        from .learning.runtime import TrainedRouter
        _routers[version] = TrainedRouter(db().classifier_releases.find_one({"_id": version}))
    return _routers[version].classify(snap)


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(incident_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(incident_id, threading.Lock())


# ---------- incidents ----------

def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _target(src: dict) -> dict:
    return {"flightId": src["flightId"], "status": src["status"], "sourceVersion": src["sourceVersion"],
            "sourceTime": src["sourceTime"]}


def _failed_clause(e: OperationFailure) -> str | None:
    """Which clause of the validator MongoDB says failed (from errInfo), for the audit trail and the demo."""
    try:
        clauses = e.details["errInfo"]["details"]["clausesNotSatisfied"]
        return {0: "schema: state/target shape", 1: "rule 1: approval for current version",
                2: "rule 2: matching read after the command"}.get(clauses[0]["index"], str(clauses[0]["index"]))
    except Exception:
        return None


def audit(incident_id: str, kind: str, **detail) -> None:
    """Append-only record of each state change and each write MongoDB refused (not transactional on standalone)."""
    db().audit_events.insert_one({"incidentId": incident_id, "kind": kind, "at": now_ms(), **detail})


def open_incident(flight_id: str) -> dict:
    src = simulator.read_source(flight_id)
    inc = {"_id": f"INC-{uuid.uuid4().hex[:8]}", "flightId": flight_id, "state": "investigating", "revision": 0,
           "target": _target(src), "approval": None, "command": None, "resolution": None, "commandSeq": 0, "createdAt": now_ms(),
           "classifierVersion": active_version(), "label": simulator.LABEL}
    db().incidents.insert_one(inc)
    audit(inc["_id"], "opened", state="investigating")
    return inc


def get_incident(incident_id: str) -> dict:
    inc = db().incidents.find_one({"_id": incident_id})
    if not inc:
        raise KeyError(incident_id)
    return inc


def _update(inc: dict, expected_rev: int, fields: dict) -> dict:
    """Optimistic update: only applies if the incident revision is unchanged."""
    try:
        r = db().incidents.find_one_and_update({"_id": inc["_id"], "revision": expected_rev},
                                               {"$set": fields, "$inc": {"revision": 1}},
                                               return_document=ReturnDocument.AFTER)
    except OperationFailure as e:  # code 121: MongoDB's validator refused the write
        audit(inc["_id"], "rejected_by_mongodb", attempted=fields.get("state"), code=e.code,
              rule=_failed_clause(e), error=str(e.details.get("errmsg", e)) if e.details else str(e))
        raise
    if r is None:
        raise RuntimeError("revision_conflict")
    audit(inc["_id"], "state_change", state=r["state"], revision=r["revision"])
    return r


# ---------- evidence ----------

def observe(inc: dict) -> tuple[dict, dict]:
    """Read both systems and persist both observations (separate records, with source time != observed time)."""
    fid = inc["flightId"]
    sent = (inc.get("command") or {}).get("sentAt")
    if sent is not None:  # a verifying read must be strictly after the command (validator rule 2)
        while now_ms() <= int(sent.timestamp() * 1000):
            time.sleep(0.001)
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


def _snapshot(inc: dict, intent: str, read_ids: list, reasoner_calls: int, text: str = "", src=None, disp=None) -> dict:
    cmd = inc.get("command")
    ap = inc.get("approval")
    read = bool(read_ids)
    return {"incidentId": inc["_id"], "revision": inc["revision"], "state": inc["state"], "intent": intent,
            "text": text, "readThisTurn": read, "evidenceIds": read_ids, "reasonerCalls": reasoner_calls,
            "commandAcked": bool(cmd and cmd["status"] == "acked" and inc["state"] == "refresh_pending"),
            "approvalPending": bool(ap and ap["status"] == "pending"),
            "evUnavailable": bool(read and not (src and src["available"] and disp and disp["available"])),
            "evMismatch": bool(read and src and disp and src["available"] and disp["available"]
                               and not policy.same_target(src, disp))}


# ---------- approval / command (server-enforced; the classifier can never reach these) ----------

def _request_approval(inc: dict, src: dict) -> dict:
    ap = inc.get("approval")
    if inc["state"] == "awaiting_approval" and ap and ap["status"] == "pending" \
            and ap["sourceVersion"] == src["sourceVersion"]:
        return inc
    approval = {"approvalId": uuid.uuid4().hex[:10], "status": "pending", "flightId": inc["flightId"],
                "action": "refresh_display", "sourceVersion": src["sourceVersion"], "requestedAt": now_ms(),
                "expiresAt": now_ms() + policy.APPROVAL_TTL_MS, "supervisorId": None}
    return _update(inc, inc["revision"], {"state": "awaiting_approval", "approval": approval, "target": _target(src)})


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
                   "status": "intent", "intentAt": now_ms(), "sentAt": _dt(now_ms()), "ackAt": None, "label": simulator.LABEL}
        db().commands.insert_one(dict(command))  # intent persisted before sending
        ap = {**ap, "status": "approved", "supervisorId": supervisor, "approvedAt": now_ms()}
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
        ap = {**ap, "status": "rejected", "supervisorId": supervisor, "decidedAt": now_ms()}
        return _update(inc, inc["revision"], {"state": "investigating", "approval": ap})  # no write


# ---------- turn loop ----------

def _record_decision(inc, turn_id, step, d, override, snap, started):
    db().decisions.insert_one({
        "incidentId": inc["_id"], "turnId": turn_id, "step": step, "route": d.route, "reason": d.reason,
        "classifierVersion": d.classifier_version, "probability": d.probability, "evidenceIds": snap["evidenceIds"],
        "gateOverride": override, "snapshot": {k: snap[k] for k in ("revision", "state", "intent", "readThisTurn",
                                                                      "commandAcked", "reasonerCalls")},
        "at": now_ms(), "latencyMs": round((time.perf_counter() - started) * 1000, 3)})


def _respond(inc: dict, intent: str, reason: str, src, disp) -> tuple[str, dict]:
    """Render an approved template from observed facts; apply deterministic state transitions."""
    fid = inc["flightId"]
    if reason == "approval_is_ui_only":
        return responses.render("approval_is_ui_only", fid, None, None), inc
    if intent == "unknown":
        intent = "status_query"  # a learned route may answer, but only with the read-only template; never closes
    if not (src and src["available"]):
        return responses.render("unavailable", fid, src, disp, {"system": "airline feed"}), inc
    if not (disp and disp["available"]):
        return responses.render("unavailable", fid, src, disp, {"system": "airport display"}), inc
    ok, why = policy.can_close(src, disp, inc.get("command") if inc["state"] == "refresh_pending" else None, fid)
    if intent == "status_query":
        return responses.render("status", fid, src, disp), inc
    if ok:
        had_cmd = inc["state"] == "refresh_pending"
        if not had_cmd:  # validator rule 2 requires a command; with none sent there is nothing to close here
            return responses.render("consistent", fid, src, disp), inc
        verification = {"observationId": disp["_id"], "sourceObservationId": src["_id"], "flightId": disp["flightId"],
                        "displayStatus": disp["status"], "displayVersion": disp["sourceVersion"],
                        "displaySourceTime": disp["sourceTime"], "observedAt": _dt(disp["observedAt"])}
        resolution = {"verifiedAt": now_ms(), "sourceVersion": src["sourceVersion"],
                      "evidenceIds": [src["_id"], disp["_id"]], "commandId": inc["command"]["commandId"]}
        try:
            inc = _update(inc, inc["revision"], {"state": "resolved", "verification": verification,
                                                 "resolution": resolution})
        except OperationFailure:
            return responses.render("rejected_by_mongodb", fid, src, disp), inc
        return responses.render("closed_verified", fid, src, disp), inc
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
        tool_order, route_trail, reasoner_calls = [], [], 0
        src = disp = None
        read_ids: list = []
        response = None
        for step in range(policy.MAX_STEPS):
            started = time.perf_counter()
            inc = get_incident(incident_id)  # reload: revision may have changed
            snap = _snapshot(inc, intent, read_ids, reasoner_calls, text, src, disp)
            d, override = policy.gate(_route(inc["classifierVersion"], snap), snap)
            _record_decision(inc, turn_id, step, d, override, snap, started)
            route_trail.append(d.route)
            if d.route in ("READ_STATE", "VERIFY_EFFECT"):
                tool_order.append(d.route.lower())
                src, disp = observe(inc)
                read_ids = [src["_id"], disp["_id"]]
                continue
            if d.route == "DELEGATE_TO_REASONER":
                reasoner_calls += 1
                tool_order.append("reasoner")
                response = responses.render("reasoner_unavailable", inc["flightId"], None, None) \
                    if reasoner.propose(inc, text) is None else None
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
        done = {"response": response, "routes": route_trail, "toolOrder": tool_order, "reasonerCalls": reasoner_calls,
                "state": inc["state"], "latencyMs": round((time.perf_counter() - t0) * 1000, 3),
                "evidenceIds": read_ids, "completedAt": now_ms(), "status": "complete"}
        db().turns.update_one({"incidentId": incident_id, "turnId": turn_id}, {"$set": done})
        return {**turn, **done, "duplicate": False}


# ---------- red team: forbidden writes that bypass the engine (demo + tests) ----------

TAMPERS = {
    "refresh_without_approval": "Skip the supervisor: set the incident to refresh_pending with no approval",
    "close_without_evidence": "Claim it is fixed: set the incident to resolved with no verification",
    "close_on_ack_only": "Treat the acknowledgment as recovery: resolve using what the display actually shows",
    "duplicate_effect": "Resend a command: insert a second applied effect for the same commandId",
}


def tamper(incident_id: str, kind: str) -> dict:
    """Attempt a write the rules forbid, directly against MongoDB. Returns what MongoDB said.
    Only forbidden payloads are used; a real engine path is never touched, so a refusal leaves the incident as is."""
    inc = get_incident(incident_id)
    d = db()
    out = {"kind": kind, "attempt": TAMPERS[kind]}
    noop = {**out, "refused": False, "noop": True}
    try:
        if kind == "refresh_without_approval":
            res = d.incidents.update_one({"_id": incident_id}, {"$set": {
                "state": "refresh_pending", "approval": {"sourceVersion": inc["target"]["sourceVersion"]}}})  # no supervisor
        elif kind == "close_without_evidence":  # invalid in every state: no verification at all
            res = d.incidents.update_one({"_id": incident_id}, {"$set": {"state": "resolved"}, "$unset": {"verification": ""}})
        elif kind == "close_on_ack_only":
            disp = d.sim_display.find_one({"_id": inc["flightId"]})
            if (disp["status"], disp["sourceVersion"], disp["sourceTime"]) == (
                    inc["target"]["status"], inc["target"]["sourceVersion"], inc["target"]["sourceTime"]):
                return {**noop, "note": "The display already matches the target, so closing on it would be legitimate. "
                                        "Use an ACK-only display to see an acknowledged refresh that never applies."}
            sent = ((inc.get("command") or {}).get("sentAt")) or _dt(now_ms() - 5000)
            res = d.incidents.update_one({"_id": incident_id}, {"$set": {
                "state": "resolved", "command.sentAt": sent,
                "verification": {"observationId": "tamper", "flightId": disp["flightId"], "displayStatus": disp["status"],
                                 "displayVersion": disp["sourceVersion"], "displaySourceTime": disp["sourceTime"],
                                 "observedAt": _dt(now_ms())}}})
        elif kind == "duplicate_effect":
            eff = d.sim_effects.find_one({"flightId": inc["flightId"]})
            if not eff:
                return {**noop, "note": "No command has been applied yet, so there is nothing to duplicate."}
            d.sim_effects.insert_one({"commandId": eff["commandId"], "flightId": inc["flightId"], "applied": True,
                                      "at": now_ms(), "label": simulator.LABEL})
            res = None
        if res is not None and res.modified_count == 0:
            return {**noop, "note": "MongoDB accepted it, but it changed nothing."}
    except (OperationFailure, DuplicateKeyError) as e:
        info = (e.details or {}).get("errInfo") if hasattr(e, "details") else None
        rule = "rule 3: unique index on commandId" if isinstance(e, DuplicateKeyError) else _failed_clause(e)
        audit(incident_id, "tamper_rejected_by_mongodb", attempt=kind, rule=rule)
        return {**out, "refused": True, "code": getattr(e, "code", None), "rule": rule,
                "error": str((e.details or {}).get("errmsg", e)) if getattr(e, "details", None) else str(e)}
    audit(incident_id, "tamper_ACCEPTED", attempt=kind)  # would indicate a hole in the rules
    return {**out, "refused": False, "note": "MongoDB accepted this write."}
