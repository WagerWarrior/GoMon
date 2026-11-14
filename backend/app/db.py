"""MongoDB access: the single source of truth for incidents, evidence, decisions and commands.

Collections (see spec.md section 4):
  incidents, observations, commands, turns, decisions   -> operational state
  sim_sources, sim_displays, sim_effects                -> SIMULATOR (labeled fake airline/airport systems)
"""
import os
import time
from pymongo import ASCENDING, MongoClient

MONGO_URI = os.environ.get("MONGODB_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("MONGODB_DB", "recovery_agent")

_client: MongoClient | None = None


def client() -> MongoClient:
    global _client
    if _client is None:
        _client = MongoClient(MONGO_URI, tz_aware=True)
    return _client


def db():
    return client()[DB_NAME]


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_indexes() -> None:
    d = db()
    d.turns.create_index([("incidentId", ASCENDING), ("turnId", ASCENDING)], unique=True)
    d.commands.create_index("commandId", unique=True)
    d.sim_effects.create_index("commandId", unique=True)  # receiver-side dedup
    d.observations.create_index([("incidentId", ASCENDING), ("observedAt", ASCENDING)])
    d.decisions.create_index([("incidentId", ASCENDING), ("at", ASCENDING)])
