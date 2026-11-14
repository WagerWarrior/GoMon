"""Reasoner model seam. No reasoner model/credentials are configured in this build, so it never answers.

The engine records a reasoner call and returns an honest 'reasoner unavailable' response. We do not fake model output.
"""


def propose(incident: dict, text: str):
    return None
