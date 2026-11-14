"""Approved response templates populated ONLY with observed facts. No model-written text."""


def _fmt(o: dict) -> str:
    return f"{o['status']} from {o['sourceTime']} (v{o['sourceVersion']})"


def render(kind: str, flight: str, src: dict | None, disp: dict | None, extra: dict | None = None) -> str:
    extra = extra or {}
    if kind == "approval_is_ui_only":
        return "I can't approve or send a refresh by voice. Use Approve refresh in the dashboard."
    if kind == "unavailable":
        return (f"Not yet. I can't read the {extra.get('system', 'airport display')} for {flight}, "
                "so nothing is verified and the incident stays open.")
    if kind == "mismatch":
        return (f"Not yet. The airport display still shows {_fmt(disp)}; the airline feed has {_fmt(src)}. "
                "Approve a refresh to send the update.")
    if kind == "mismatch_after_refresh":
        return (f"Not yet. The refresh was acknowledged but the display still shows {_fmt(disp)} "
                f"while the airline feed has {_fmt(src)}. An acknowledgment is not recovery; the incident stays open.")
    if kind == "closed_verified":
        return (f"Yes. After the refresh, a fresh read shows {flight} matches on both systems: {_fmt(disp)}. "
                "The incident is closed. This holds for that observation only.")
    if kind == "consistent":
        return (f"The display and airline feed agree for {flight}: {_fmt(disp)}. "
                "Closed on that fresh observation only.")
    if kind == "status":
        return f"Airline feed: {_fmt(src)}. Airport display: {_fmt(disp)}."
    if kind == "reasoner_unavailable":
        return ("That request needs the reasoner model, which isn't configured in this build. "
                "Nothing was changed and the incident stays as it is.")
    if kind == "budget":
        return "I hit the per-turn step budget before reaching a supported answer. Nothing was changed."
    return "No supported answer."
