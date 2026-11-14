import uuid
import pytest
from app import db as dbmod, simulator


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    name = f"test_{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(dbmod, "DB_NAME", name)
    dbmod.ensure_indexes()
    yield name
    dbmod.client().drop_database(name)


@pytest.fixture
def hx101():
    simulator.seed_flight("HX101", "Delayed", "10:20", 2, "On time", "10:05", 1)
    return "HX101"
