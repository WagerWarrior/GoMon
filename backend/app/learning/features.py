"""Versioned feature extraction. Inputs are ONLY what is known at a decision boundary (spec section 4)."""
import zlib

import numpy as np

SCHEMA = "feat-v1"
HASH_DIM = 256
STATES = ("investigating", "awaiting_approval", "refresh_pending", "resolved")
FLAGS = ("readThisTurn", "commandAcked", "approvalPending", "evUnavailable", "evMismatch")
ROUTES = ("RESPOND_NOW", "READ_STATE", "VERIFY_EFFECT", "DELEGATE_TO_DRIVER")  # REQUEST_APPROVAL: no labels yet
DIM = HASH_DIM + len(STATES) + len(FLAGS) + 2


def _ngrams(text: str):
    t = " " + "".join(c for c in text.lower() if c.isalnum() or c == " ").strip() + " "
    for n in (2, 3, 4):
        for i in range(len(t) - n + 1):
            yield t[i:i + n]


def featurize(s: dict) -> np.ndarray:
    x = np.zeros(DIM)
    grams = list(_ngrams(s.get("text", "")))
    for g in grams:
        x[zlib.crc32(g.encode()) % HASH_DIM] += 1.0
    if grams:
        x[:HASH_DIM] /= np.linalg.norm(x[:HASH_DIM]) or 1.0
    o = HASH_DIM
    if s.get("state") in STATES:
        x[o + STATES.index(s["state"])] = 1.0
    o += len(STATES)
    for i, f in enumerate(FLAGS):
        x[o + i] = 1.0 if s.get(f) else 0.0
    o += len(FLAGS)
    x[o] = min(s.get("driverCalls", 0), 3) / 3.0
    x[o + 1] = 1.0  # bias
    return x
