"""Offline training: multinomial linear classifier (softmax regression, L2) + temperature calibration +
per-route thresholds tuned on VALIDATION only. Produces an immutable release record (never mutated live)."""
import hashlib
import json

import numpy as np

from ..db import db, now_ms
from . import features as F


def _xy(rows):
    X = np.stack([F.featurize(r["snapshot"]) for r in rows])
    y = np.array([F.ROUTES.index(r["label"]) for r in rows])
    return X, y


def _softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def fit(X, y, l2=1e-3, lr=0.5, epochs=600, seed=0):
    rng = np.random.default_rng(seed)
    W = rng.normal(0, 0.01, (X.shape[1], len(F.ROUTES)))
    Y = np.eye(len(F.ROUTES))[y]
    for _ in range(epochs):
        P = _softmax(X @ W)
        W -= lr * (X.T @ (P - Y) / len(X) + l2 * W)
    return W


def calibrate_temperature(logits, y):
    best, bt = 1e9, 1.0
    for t in np.arange(0.25, 4.01, 0.05):
        P = _softmax(logits / t)
        nll = -np.log(P[np.arange(len(y)), y] + 1e-12).mean()
        if nll < best:
            best, bt = nll, float(t)
    return bt, float(best)


def tune_thresholds(P, y):
    """Per route: smallest threshold whose accepted predictions on validation contain no errors."""
    grid = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]
    pred, conf = P.argmax(1), P.max(1)
    th = {}
    for i, route in enumerate(F.ROUTES):
        th[route] = 0.99
        for g in grid:
            m = (pred == i) & (conf >= g)
            if m.any() and (y[m] == i).all():
                th[route] = g
                break
    return th


L2_GRID = (1e-4, 1e-3, 1e-2, 3e-2)


def _lofo(rows, l2):
    """Leave-one-family-out: fit on all other phrasing families, predict the held-out one.
    Returns out-of-family logits and labels, i.e. performance on UNSEEN wording."""
    X, y = _xy(rows)
    fam = np.array([r["family"] for r in rows])
    out = np.zeros((len(rows), len(F.ROUTES)))
    for f in sorted(set(fam)):
        m = fam == f
        out[m] = X[m] @ fit(X[~m], y[~m], l2=l2)
    return out, y


def _unsafe(logits, y, T=1.0):
    P = _softmax(logits / T)
    return int(((P.argmax(1) == 0) & (y != 0)).sum()), float((P.argmax(1) == y).mean())


def train_release(rev: str, train_rows, val_rows) -> dict:
    rows = train_rows + val_rows  # test and burned splits are never touched here
    best = None
    for l2 in L2_GRID:
        lg, yy = _lofo(rows, l2)
        uns, acc = _unsafe(lg, yy)
        if best is None or (uns, -acc) < (best[1], -best[2]):
            best = (l2, uns, acc, lg, yy)
    l2, uns, acc, oof, yoof = best
    T, nll = calibrate_temperature(oof, yoof)       # calibrated on out-of-family predictions
    th = tune_thresholds(_softmax(oof / T), yoof)   # thresholds from unseen-wording predictions
    X, y = _xy(rows)
    W = fit(X, y, l2=l2)
    Pv = _softmax(oof / T)
    yv = yoof
    body = {"featureSchema": F.SCHEMA, "routes": list(F.ROUTES), "weights": W.round(8).tolist(),
            "temperature": T, "thresholds": th}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    version = f"linear-{digest[:8]}"
    return {"_id": version, "version": version, **body, "artifactDigest": digest, "datasetRevision": rev,
            "trainedOn": {"examples": len(rows), "families": sorted({r["family"] for r in rows}), "l2": l2},
            "crossValidation": {"method": "leave-one-family-out", "examples": len(rows), "nll": nll,
                                "accuracyRaw": float((Pv.argmax(1) == yv).mean()), "unsafeEarlyRaw": uns},
            "status": "candidate", "createdAt": now_ms(), "label": "SIMULATED data, oracle labels"}


def save(rel: dict) -> None:
    db().classifier_releases.replace_one({"_id": rel["_id"]}, rel, upsert=True)
