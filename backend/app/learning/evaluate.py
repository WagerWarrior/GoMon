"""Compare always-driver, bootstrap, and a trained release on identical held-out boundaries.

Reports raw numbers. Latency here is CLASSIFIER OVERHEAD only: the driver is not configured, so no
end-to-end or driver latency is claimed.
"""
import time

from .. import classifier
from ..policy import gate
from . import oracle as _o  # noqa: F401


def _bootstrap(snap):
    s = {**snap, "intent": classifier.intent_of(snap["text"]), "evidenceIds": []}
    return classifier.classify(s)


def _always_driver(snap):
    return classifier.Decision("DELEGATE_TO_DRIVER", "baseline_always_driver", [], "always-driver")


def _metrics(rows, fn):
    n = len(rows)
    correct = delegate = raw_unsafe = gated_unsafe = 0
    confusion: dict = {}
    t0 = time.perf_counter()
    for r in rows:
        snap = r["snapshot"]
        d = fn(snap)
        if d.route == "DELEGATE_TO_DRIVER":
            delegate += 1
        correct += d.route == r["label"]
        confusion[f"{r['label']}->{d.route}"] = confusion.get(f"{r['label']}->{d.route}", 0) + 1
        if d.route == "RESPOND_NOW" and r["label"] != "RESPOND_NOW":
            raw_unsafe += 1
            g, _ = gate(d, {**snap, "intent": r["intent"], "driverCalls": 0, "commandAcked": bool(snap["commandAcked"])})
            gated_unsafe += g.route == "RESPOND_NOW"
    ms = (time.perf_counter() - t0) * 1000 / n
    unsafe_den = sum(r["label"] != "RESPOND_NOW" for r in rows)
    return {"n": n, "accuracy": correct / n, "driverCallRate": delegate / n,
            "unsafeEarlyRaw": raw_unsafe, "unsafeEarlyAfterGate": gated_unsafe, "unsafeDenominator": unsafe_den,
            "classifierOverheadMsPerBoundary": round(ms, 4), "confusion": confusion}


def evaluate(rows, release_router, split_name: str):
    systems = {"always-driver": _always_driver, "bootstrap-v0": _bootstrap, release_router.version: release_router.classify}
    oracle_delegate = sum(r["label"] == "DELEGATE_TO_DRIVER" for r in rows) / len(rows)
    return {"split": split_name, "oracleDriverCallRateFloor": oracle_delegate,
            "systems": {k: _metrics(rows, f) for k, f in systems.items()}}


def promotion_decision(report: dict, version: str) -> tuple[bool, list[str]]:
    c, b = report["systems"][version], report["systems"]["bootstrap-v0"]
    why = []
    if c["unsafeEarlyRaw"] != 0:
        why.append(f"unsafe early responses on safety suite: {c['unsafeEarlyRaw']}/{c['unsafeDenominator']}")
    if c["unsafeEarlyAfterGate"] != 0:
        why.append(f"unsafe after policy gate: {c['unsafeEarlyAfterGate']}")
    if c["accuracy"] < b["accuracy"]:
        why.append(f"accuracy regression vs bootstrap: {c['accuracy']:.3f} < {b['accuracy']:.3f}")
    return (not why), why
