"""Deterministic policy gates. These run regardless of classifier confidence and own permission and closure."""
from .classifier import Decision

APPROVAL_TTL_MS = 5 * 60 * 1000
MAX_STEPS = 6            # classifier boundaries per turn
MAX_REASONER_CALLS = 1     # bounded reasoner budget per turn


def gate(d: Decision, s: dict) -> tuple[Decision, str | None]:
    """Return (possibly overridden decision, override reason). No route can write or close by itself."""
    if d.route == "RESPOND_NOW" and not s["readThisTurn"] and s["intent"] != "approve_attempt":
        return Decision("VERIFY_EFFECT" if s["commandAcked"] else "READ_STATE", "gate:missing_current_evidence",
                        d.evidence, d.classifier_version, d.probability), "RESPOND_NOW without current evidence"
    if d.route == "DELEGATE_TO_REASONER" and s["reasonerCalls"] >= MAX_REASONER_CALLS:
        return Decision("RESPOND_NOW", "gate:reasoner_budget_exhausted", d.evidence, d.classifier_version,
                        d.probability), "reasoner budget exhausted"
    return d, None


def same_target(src: dict, disp: dict) -> bool:
    return all(src[k] == disp[k] for k in ("flightId", "status", "sourceVersion", "sourceTime"))


def can_close(src: dict | None, disp: dict | None, command: dict | None, incident_flight: str) -> tuple[bool, str]:
    """Close only on a fresh read where both systems agree on flight, status, source version and source time.
    An acknowledgment alone is never enough: with a command, both reads must come after the ACK."""
    if not src or not src["available"] or not disp or not disp["available"]:
        return False, "evidence_unavailable"
    if src["flightId"] != incident_flight or disp["flightId"] != incident_flight:
        return False, "wrong_flight"
    if not same_target(src, disp):
        return False, "mismatch"
    if command is not None:
        ack_at = command.get("ackAt")
        if ack_at is None or src["observedAt"] < ack_at or disp["observedAt"] < ack_at:
            return False, "no_post_ack_reads"
    return True, "verified"
