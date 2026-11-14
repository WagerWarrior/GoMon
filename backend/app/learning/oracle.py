"""Oracle labels from the spec's per-route evidence requirements (spec section 4 table).

The generator knows each utterance's TRUE intent because it composed it; the oracle never looks at keywords
or at the bootstrap router, and never at a driver model.
"""


def label(intent: str, s: dict) -> str:
    if intent == "unknown":
        return "DELEGATE_TO_DRIVER"
    if intent == "approve_attempt":
        return "RESPOND_NOW"           # templated refusal: approval is UI-only
    if not s["readThisTurn"]:
        return "VERIFY_EFFECT" if s["commandAcked"] else "READ_STATE"
    return "RESPOND_NOW"               # current evidence + supported intent
