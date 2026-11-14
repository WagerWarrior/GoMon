"""HTTP API + single-screen dashboard. Run: uvicorn app.api:app --port 8000 (from backend/)."""
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import engine, simulator
from .db import db, ensure_indexes

app = FastAPI(title="Recovery agent (SIMULATED data)")
STATIC = Path(__file__).parent / "static"


@app.on_event("startup")
def _startup():
    ensure_indexes()


def _clean(doc):
    if isinstance(doc, dict):
        return {k: _clean(v) for k, v in doc.items()}
    if isinstance(doc, list):
        return [_clean(v) for v in doc]
    if doc.__class__.__name__ == "ObjectId":
        return str(doc)
    return doc


class NewIncident(BaseModel):
    flightId: str = "HX101"
    applyMode: str = "applies"  # 'ack_only' demonstrates ACK-is-not-recovery


class Turn(BaseModel):
    turnId: str | None = None
    text: str


class Decision(BaseModel):
    supervisor: str
    approvalId: str


@app.post("/api/incidents")
def create(body: NewIncident):
    simulator.seed_flight(body.flightId, "Delayed", "10:20", 2, "On time", "10:05", 1, body.applyMode)
    return _clean(engine.open_incident(body.flightId))


@app.post("/api/incidents/{iid}/reconnect")
def reconnect(iid: str):
    simulator.reconnect(engine.get_incident(iid)["flightId"])
    return {"ok": True}


@app.get("/api/incidents/{iid}")
def view(iid: str):
    try:
        inc = engine.get_incident(iid)
    except KeyError:
        raise HTTPException(404, "unknown incident")
    d = db()
    return _clean({
        "incident": inc,
        "observations": list(d.observations.find({"incidentId": iid}).sort("observedAt", 1)),
        "decisions": list(d.decisions.find({"incidentId": iid}, {"_id": 0}).sort("at", 1)),
        "turns": list(d.turns.find({"incidentId": iid}, {"_id": 0}).sort("startedAt", 1)),
        "commands": list(d.commands.find({"incidentId": iid}, {"_id": 0})),
        "effects": list(d.sim_effects.find({"flightId": inc["flightId"]}, {"_id": 0})),
        "simulator": {"source": d.sim_sources.find_one({"_id": inc["flightId"]}),
                      "display": d.sim_displays.find_one({"_id": inc["flightId"]})}})


@app.post("/api/incidents/{iid}/turns")
def turn(iid: str, body: Turn):
    try:
        return _clean(engine.handle_turn(iid, body.turnId or uuid.uuid4().hex[:8], body.text))
    except KeyError:
        raise HTTPException(404, "unknown incident")


@app.post("/api/incidents/{iid}/approve")
def approve(iid: str, body: Decision):
    try:
        return _clean(engine.approve(iid, body.supervisor, body.approvalId))
    except PermissionError as e:
        raise HTTPException(409, str(e))


@app.post("/api/incidents/{iid}/reject")
def reject(iid: str, body: Decision):
    try:
        return _clean(engine.reject(iid, body.supervisor, body.approvalId))
    except PermissionError as e:
        raise HTTPException(409, str(e))


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
