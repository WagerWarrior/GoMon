"""Inference for a stored release. Calibrated probability, per-route thresholds, abstain -> reasoner."""
import numpy as np

from ..classifier import Decision
from . import features as F


class TrainedRouter:
    def __init__(self, release: dict):
        self.version = release["version"]
        self.W = np.array(release["weights"])
        self.T = release["temperature"]
        self.th = release["thresholds"]

    def probs(self, snap: dict):
        z = (F.featurize(snap) @ self.W) / self.T
        z -= z.max()
        e = np.exp(z)
        return e / e.sum()

    def classify(self, snap: dict) -> Decision:
        p = self.probs(snap)
        i = int(p.argmax())
        route = F.ROUTES[i]
        ev = snap.get("evidenceIds", [])
        if p[i] < self.th[route]:  # conservative: abstain to the reasoner rather than act on a weak route
            return Decision("DELEGATE_TO_REASONER", "abstain_below_threshold", ev, self.version, float(p[i]))
        return Decision(route, "learned_route", ev, self.version, float(p[i]))
