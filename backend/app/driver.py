"""Driver model seam. No driver model/credentials are configured in this build, so it never answers.

The engine records a driver call and returns an honest 'driver unavailable' response. We do not fake model output.
"""


def propose(incident: dict, text: str):
    return None
