"""Generate oracle-labeled boundary snapshots from simulated scenario families and store them in MongoDB.

Split by PHRASING FAMILY (so paraphrases never cross splits): train / validation / frozen test.
"""
import hashlib
import itertools
import random

from ..db import db, now_ms
from . import oracle

PROVENANCE = "oracle:spec-table-v1"

# family -> intent -> utterances. Test families use wording absent from train/validation.
FAMILIES = {
    "F1_direct": {"split": "train", "u": {
        "close_query": ["Can I close this incident?", "Can we close HX101?", "The connection is back, can I close this?"],
        "status_query": ["What does the display show?", "Show me the mismatch.", "What is the status of the flight?"],
        "approve_attempt": ["Approve the refresh.", "Go ahead and refresh the display.", "Do it, approve."],
        "unknown": ["Book me a taxi.", "What's the weather today?", "Tell me a joke."]}},
    "F2_polite": {"split": "train", "u": {
        "close_query": ["Is it safe to close it now?", "Could you check whether we can close this?", "May I close the incident please?"],
        "status_query": ["Why is the display stale?", "Could you show me what the screens say?", "What happened to the update?"],
        "approve_attempt": ["Please approve the refresh.", "Yes, go ahead and send the refresh.", "Approve it please."],
        "unknown": ["Please order me lunch.", "Could you play some music?", "Remind me about my meeting."]}},
    "F3_verify": {"split": "train", "u": {
        "close_query": ["Verify the refresh.", "Verify it worked and close.", "Is the incident resolved?"],
        "status_query": ["Show the current state.", "What does the airline feed say?", "Show status."],
        "approve_attempt": ["Send the refresh now.", "Approve and refresh.", "Refresh it, I approve."],
        "unknown": ["Verify my email address.", "Who won the game?", "Translate hello to French."]}},
    "F4_val": {"split": "validation", "u": {
        "close_query": ["Has it recovered yet?", "Are we clear to close?", "Can I mark this incident closed?"],
        "status_query": ["What is the display showing?", "Why does it look stale?", "Show me where things stand."],
        "approve_attempt": ["Yes, send it.", "I approve, refresh the board.", "Go ahead, approve."],
        "unknown": ["Play some jazz.", "Set a timer for ten minutes.", "What's for dinner?"]}},
    "F5_test1_phrasing": {"split": "burned_test1", "u": {  # frozen test of release 1: never trained/tuned on again
        "close_query": ["Wrap this ticket up?", "Good to shut this one down?", "Can I sign this off and close it?"],
        "status_query": ["Where do we stand?", "Give me the readout on the board.", "What's the display saying right now?"],
        "approve_attempt": ["OK push the update out.", "Do it now please, approved.", "Approved, refresh it."],
        "unknown": ["Uh.", "Mm hm the thing.", "Order me a coffee."]}},
    "F6_test1_voice": {"split": "burned_test1", "u": {  # see F5_test1_phrasing
        "close_query": ["can i close it", "tell me if hx101 is done", "close incident now"],
        "status_query": ["whats on the screen", "is the display stale", "status of hx101"],
        "approve_attempt": ["approve it", "refresh the display now", "yes approved go"],
        "unknown": ["hmm", "what time is it", "call my manager"]}},
    "F10_train_c": {"split": "train", "u": {
        "close_query": ["Can the incident be closed?", "Am I good to close this?", "Check and tell me if I can close it."],
        "status_query": ["Tell me what the display says.", "What's the current mismatch?", "Display status please."],
        "approve_attempt": ["Yes approve the refresh.", "Approved, send the refresh.", "Run the refresh, I approve."],
        "unknown": ["Hmm.", "Well, um.", "Hold on a second.", "Order a pizza.", "Call the front desk.", "Turn off the lights.",
                    "What's the capital of France?", "Never mind.", "Okay.", "Thanks."]}},
    "F7_val_b": {"split": "validation", "u": {
        "close_query": ["Is this one finished?", "Can the incident be closed out?"],
        "status_query": ["Tell me about the screens.", "What do both systems say?"],
        "approve_attempt": ["Yes do the refresh.", "Approved, push it."],
        "unknown": ["Er.", "Right, so, um.", "Buy me a sandwich.", "Open the garage door.", "Hello?", "Sing me a song."]}},
    "F8_test2_phrasing": {"split": "burned_test2", "u": {
        "close_query": ["Can this incident be put to bed?", "Are we done with HX101 and can I close?", "Is it fine to end this incident?"],
        "status_query": ["How does the board look?", "Read me what each system has.", "Is the screen out of date?"],
        "approve_attempt": ["Right, refresh it, I'm approving.", "Fire off the refresh, approved.", "You have my approval, go."],
        "unknown": ["Where's the nearest gym?", "Open the pod bay doors.", "Ahh, hold on.", "Cancel my subscription.", "Hm, never mind."]}},
    "F9_test2_voice": {"split": "burned_test2", "u": {
        "close_query": ["ok can it close now", "is hx101 closed out", "close it"],
        "status_query": ["screen status", "whats hx101 showing", "board stale"],
        "approve_attempt": ["refresh approved", "yeah push it", "approve refresh now"],
        "unknown": ["uh huh", "weather", "turn it up", "text my wife"]}},
    "F11_test3_phrasing": {"split": "test", "u": {
        "close_query": ["Can I call this one resolved and close it?", "Is HX101 good to close?", "Anything stopping me from closing this?"],
        "status_query": ["Give me the current picture.", "What are the two systems reporting?", "Does the display match the feed?"],
        "approve_attempt": ["I authorize the refresh.", "Yes, send the update to the display.", "Refresh approved by me."],
        "unknown": ["Sorry, what?", "Read me the news.", "Add milk to the list.", "Uhm, give me a sec.", "Where did I park?"]}},
    "F12_test3_voice": {"split": "test", "u": {
        "close_query": ["can i shut hx101", "is it fixed can i close", "ok close this"],
        "status_query": ["display state", "whats the feed say", "is hx101 stale"],
        "approve_attempt": ["go ahead refresh", "approved send it", "yes do the refresh"],
        "unknown": ["um", "play podcast", "call mom", "huh"]}},
}

# boundary states: (state, readThisTurn, commandAcked, approvalPending, evUnavailable, evMismatch)
BOUNDARIES = [
    ("investigating", 0, 0, 0, 0, 0), ("investigating", 1, 0, 0, 0, 1), ("investigating", 1, 0, 0, 0, 0),
    ("investigating", 1, 0, 0, 1, 0), ("awaiting_approval", 0, 0, 1, 0, 0), ("awaiting_approval", 1, 0, 1, 0, 1),
    ("refresh_pending", 0, 1, 0, 0, 0), ("refresh_pending", 1, 1, 0, 0, 0), ("refresh_pending", 1, 1, 0, 0, 1),
    ("resolved", 0, 0, 0, 0, 0), ("resolved", 1, 0, 0, 0, 0),
]
SPLITS = ("train", "validation", "test", "burned_test1", "burned_test2")
FLAGS = ("readThisTurn", "commandAcked", "approvalPending", "evUnavailable", "evMismatch")


def build(seed: int = 7) -> tuple[str, list[dict]]:
    rng = random.Random(seed)
    rows = []
    for fam, spec in FAMILIES.items():
        for intent, utts in spec["u"].items():
            for text, b in itertools.product(utts, BOUNDARIES):
                snap = {"text": text, "state": b[0], "driverCalls": 0, **dict(zip(FLAGS, b[1:]))}
                rows.append({"family": fam, "split": spec["split"], "intent": intent, "snapshot": snap,
                             "label": oracle.label(intent, snap), "provenance": PROVENANCE})
    rng.shuffle(rows)
    rev = "ds-" + hashlib.sha256(repr([(r["family"], r["snapshot"], r["label"]) for r in rows]).encode()).hexdigest()[:10]
    for r in rows:
        r["datasetRevision"] = rev
    return rev, rows


def store(rev: str, rows: list[dict]) -> None:
    d = db().training_examples
    d.delete_many({"datasetRevision": rev})
    now = now_ms()
    d.insert_many([{**r, "createdAt": now} for r in rows])
    db().dataset_revisions.replace_one({"_id": rev}, {
        "_id": rev, "count": len(rows), "createdAt": now, "provenance": PROVENANCE,
        "label": "SIMULATED scenario families; oracle labels, no driver-model labels",
        "splits": {s: sum(r["split"] == s for r in rows) for s in ("train", "validation", "test", "burned_test1")},
        "familiesBySplit": {s: sorted({r["family"] for r in rows if r["split"] == s}) for s in ("train", "validation", "test", "burned_test1")}},
        upsert=True)


def load(rev: str, split: str) -> list[dict]:
    return list(db().training_examples.find({"datasetRevision": rev, "split": split}))
