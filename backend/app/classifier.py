"""Bootstrap router (transparent rules, release 'bootstrap-v0'). NOT a trained model.

It runs before every reasoner call and after every tool result. Output carries a reasonCode and evidence IDs.
`probability` is None on purpose: this release is uncalibrated; the trained, calibrated release is increment 3.
"""
from dataclasses import dataclass, field

VERSION = "bootstrap-v0"
ROUTES = ("RESPOND_NOW", "READ_STATE", "REQUEST_APPROVAL", "VERIFY_EFFECT", "DELEGATE_TO_REASONER")

_CLOSE = ("close", "resolved", "verify", "done", "can i")
_STATUS = ("status", "what", "why", "mismatch", "stale", "show")
_APPROVE = ("approve", "refresh", "go ahead", "do it")


def intent_of(text: str) -> str:
    t = text.lower()
    if any(k in t for k in _CLOSE):  # "verify the refresh" is a verification request, not an approval attempt
        return "close_query"
    if any(k in t for k in _APPROVE):
        return "approve_attempt"  # voice can never approve; answered from a template
    if any(k in t for k in _STATUS):
        return "status_query"
    return "unknown"


@dataclass
class Decision:
    route: str
    reason: str
    evidence: list = field(default_factory=list)
    classifier_version: str = VERSION
    probability: float | None = None


def classify(s: dict) -> Decision:
    """s = boundary snapshot (see engine.snapshot). Only information available at this boundary is used."""
    intent = s["intent"]
    ev = s["evidenceIds"]
    if intent == "unknown":
        return Decision("DELEGATE_TO_REASONER", "unknown_intent", ev)
    if intent == "approve_attempt":
        return Decision("RESPOND_NOW", "approval_is_ui_only", ev)
    if not s["readThisTurn"]:
        if s["commandAcked"]:
            return Decision("VERIFY_EFFECT", "command_acked_needs_post_command_reads", ev)
        return Decision("READ_STATE", "no_current_evidence", ev)
    return Decision("RESPOND_NOW", "evidence_current", ev)
