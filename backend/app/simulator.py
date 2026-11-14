"""SIMULATED airline feed + airport display. Labeled fake data: fictional flights only.

Reconnecting does NOT replay the missed update: the display stays stale until a refresh command is applied.
The receiver deduplicates by commandId (one applied effect per command, recorded in sim_effects).
"""
from .db import db, now_ms

LABEL = "SIMULATED"


def seed_flight(flight_id: str, source_status: str, source_time: str, source_version: int,
                display_status: str, display_time: str, display_version: int, apply_mode: str = "applies") -> None:
    """apply_mode: 'applies' (refresh updates the display) | 'ack_only' (ACK returned, display unchanged)."""
    d = db()
    d.sim_feed.replace_one({"_id": flight_id}, {
        "_id": flight_id, "flightId": flight_id, "status": source_status, "sourceTime": source_time,
        "sourceVersion": source_version, "label": LABEL}, upsert=True)
    d.sim_display.replace_one({"_id": flight_id}, {
        "_id": flight_id, "flightId": flight_id, "status": display_status, "sourceTime": display_time,
        "sourceVersion": display_version, "label": LABEL, "applyMode": apply_mode,
        "connection": "down"}, upsert=True)
    d.sim_effects.delete_many({"flightId": flight_id})


def reconnect(flight_id: str) -> None:
    """Connection restored. Nothing is replayed, so the display stays stale."""
    db().sim_display.update_one({"_id": flight_id}, {"$set": {"connection": "up"}})


def advance_source(flight_id: str, status: str, source_time: str) -> int:
    """Source moves on (used to test approval/verification against a changing target)."""
    r = db().sim_feed.find_one_and_update(
        {"_id": flight_id}, {"$set": {"status": status, "sourceTime": source_time}, "$inc": {"sourceVersion": 1}},
        return_document=True)
    return r["sourceVersion"]


def read_source(flight_id: str):
    return db().sim_feed.find_one({"_id": flight_id})


def read_display(flight_id: str):
    d = db().sim_display.find_one({"_id": flight_id})
    if d and d.get("connection") != "up":
        return None  # unavailable: evidence cannot be read
    return d


def send_refresh(command_id: str, flight_id: str) -> dict:
    """Receiver side. Idempotent per commandId. Returns an ACK; ACK is not proof of application."""
    d = db()
    disp = d.sim_display.find_one({"_id": flight_id})
    if not disp or disp.get("connection") != "up":
        return {"ack": False, "reason": "connection_down"}
    existing = d.sim_effects.find_one({"commandId": command_id})
    if existing:
        return {"ack": True, "duplicate": True}
    src = d.sim_feed.find_one({"_id": flight_id})
    applied = disp.get("applyMode") == "applies"
    if applied:
        d.sim_display.update_one({"_id": flight_id}, {"$set": {
            "status": src["status"], "sourceTime": src["sourceTime"], "sourceVersion": src["sourceVersion"]}})
    d.sim_effects.insert_one({"commandId": command_id, "flightId": flight_id, "applied": applied, "at": now_ms(),
                              "label": LABEL})
    return {"ack": True, "duplicate": False}
