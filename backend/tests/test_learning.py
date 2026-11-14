"""Learning pipeline checks: split hygiene, oracle independence, gated promotion, release pinning."""
import pytest
from app import engine, simulator
from app.db import db
from app.learning import dataset, evaluate, oracle, run, train
from app.learning.runtime import TrainedRouter


def test_no_phrasing_family_crosses_splits():
    _, rows = dataset.build()
    fam_splits = {}
    for r in rows:
        fam_splits.setdefault(r["family"], set()).add(r["split"])
    assert all(len(v) == 1 for v in fam_splits.values())
    assert not (set(f for f, v in fam_splits.items() if "test" in v) &
                set(f for f, v in fam_splits.items() if v & {"train", "validation"}))


def test_no_test_or_burned_text_in_training_text():
    _, rows = dataset.build()
    seen = {r["snapshot"]["text"].lower() for r in rows if r["split"] in ("train", "validation")}
    held = {r["snapshot"]["text"].lower() for r in rows if r["split"] in ("test", "burned_test1", "burned_test2")}
    assert not (seen & held)


def test_oracle_labels_follow_spec_table():
    base = {"readThisTurn": False, "commandAcked": False}
    assert oracle.label("close_query", base) == "READ_STATE"
    assert oracle.label("close_query", {**base, "commandAcked": True}) == "VERIFY_EFFECT"
    assert oracle.label("close_query", {**base, "readThisTurn": True}) == "RESPOND_NOW"
    assert oracle.label("unknown", {**base, "readThisTurn": True}) == "DELEGATE_TO_DRIVER"


def test_training_only_reads_train_and_validation_and_release_is_reproducible():
    rev, rows = dataset.build()
    dataset.store(rev, rows)
    tr, va = dataset.load(rev, "train"), dataset.load(rev, "validation")
    a, b = train.train_release(rev, tr, va), train.train_release(rev, tr, va)
    assert a["artifactDigest"] == b["artifactDigest"] and a["version"] == b["version"]
    assert not ({"test", "burned_test1", "burned_test2"} & {r["split"] for r in tr + va})


def test_unsafe_candidate_is_rejected_by_the_gate():
    rev, rows = dataset.build()
    dataset.store(rev, rows)
    rel = train.train_release(rev, dataset.load(rev, "train"), dataset.load(rev, "validation"))
    router = TrainedRouter(rel)
    router.classify = lambda snap: __import__("app.classifier", fromlist=["x"]).Decision("RESPOND_NOW", "always", [], "evil")
    rep = evaluate.evaluate(dataset.load(rev, "test"), router, "test")
    ok, why = evaluate.promotion_decision(rep, router.version)
    assert not ok and any("unsafe" in w for w in why)


def test_active_release_is_pinned_and_policy_gate_still_enforced(hx101):
    rev, rows = dataset.build()
    dataset.store(rev, rows)
    rel = train.train_release(rev, dataset.load(rev, "train"), dataset.load(rev, "validation"))
    train.save(rel)
    run.promote(rel["version"])  # forced here only to test plumbing; real promotion needs the eval gate
    assert engine.active_version() == rel["version"]
    inc = engine.open_incident(hx101)
    simulator.reconnect(hx101)
    train.save({**rel, "_id": "other", "version": "other", "status": "active"})  # later promotion must not move this session
    t = engine.handle_turn(inc["_id"], "t1", "Can I close this incident?")
    assert engine.get_incident(inc["_id"])["classifierVersion"] == rel["version"]
    assert db().commands.count_documents({}) == 0 and db().sim_effects.count_documents({}) == 0
    assert t["state"] != "resolved"  # stale display can never be closed by any release
    ds = list(db().decisions.find({"incidentId": inc["_id"]}))
    assert ds and all(d["classifierVersion"] == rel["version"] for d in ds)
