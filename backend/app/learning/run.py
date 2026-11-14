"""Pipeline: generate dataset -> train candidate (train+val only) -> evaluate ONCE on frozen test -> gated promotion.
Run from backend/:  uv run python -m app.learning.run
"""
import json

from ..db import db, ensure_indexes, now_ms
from . import dataset, evaluate, train
from .runtime import TrainedRouter


def promote(version: str) -> None:
    c = db().classifier_releases
    c.update_one({"_id": version}, {"$set": {"status": "active", "promotedAt": now_ms()}})
    c.update_many({"_id": {"$ne": version}, "status": "active"}, {"$set": {"status": "retired"}})


def pipeline(seed: int = 7, quiet: bool = False) -> dict:
    ensure_indexes()
    rev, rows = dataset.build(seed)
    dataset.store(rev, rows)
    rel = train.train_release(rev, dataset.load(rev, "train"), dataset.load(rev, "validation"))
    train.save(rel)
    report = evaluate.evaluate(dataset.load(rev, "test"), TrainedRouter(rel), "test")  # frozen test, evaluated once
    ok, why = evaluate.promotion_decision(report, rel["version"])
    report.update({"datasetRevision": rev, "release": rel["version"], "promoted": ok, "rejectReasons": why,
                   "at": now_ms(), "driver": "not configured: no end-to-end/driver latency measured"})
    db().eval_reports.insert_one(dict(report))
    if ok:
        promote(rel["version"])
    else:
        db().classifier_releases.update_one({"_id": rel["version"]}, {"$set": {"status": "rejected", "rejectReasons": why}})
    if not quiet:
        report.pop("_id", None)
        print(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    pipeline()
