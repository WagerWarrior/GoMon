"""MongoDB-enforced invariants (spec section 2). The database, not the app or the model, refuses bad state.

Rule 1: no refresh without an approval naming a supervisor for the CURRENT target version.
Rule 2: no close without a read of the display taken AFTER the command was sent that matches the target.
Rule 3: no duplicate effect: unique index on sim_effects.commandId (see db.ensure_indexes).

Limits (stated in the spec): the validator checks the stored record, not the real world, and sees the document
after the write, not the transition; ordering/concurrency come from revision-conditional updates in engine.py.
"""
from pymongo.errors import CollectionInvalid

STATES = ["investigating", "awaiting_approval", "refresh_pending", "verifying", "resolved"]


def _typed(path, t):
    return {"$eq": [{"$type": path}, t]}  # missing fields compare equal inside $expr, so type-check explicitly


VALIDATOR = {"$and": [
    {"$jsonSchema": {
        "required": ["state", "revision", "target"],
        "properties": {
            "state": {"enum": STATES},
            "target": {"bsonType": "object", "required": ["flightId", "status", "sourceVersion", "sourceTime"]}}}},
    {"$or": [  # Rule 1
        {"state": {"$nin": ["refresh_pending", "verifying", "resolved"]}},
        {"$expr": {"$and": [_typed("$approval.supervisorId", "string"),
                            {"$eq": ["$approval.sourceVersion", "$target.sourceVersion"]}]}}]},
    {"$or": [  # Rule 2
        {"state": {"$ne": "resolved"}},
        {"$expr": {"$and": [
            _typed("$command.sentAt", "date"), _typed("$verification.observedAt", "date"),
            {"$gt": ["$verification.observedAt", "$command.sentAt"]},
            {"$eq": ["$verification.flightId", "$target.flightId"]},
            {"$eq": ["$verification.displayStatus", "$target.status"]},
            {"$eq": ["$verification.displayVersion", "$target.sourceVersion"]},
            {"$eq": ["$verification.displaySourceTime", "$target.sourceTime"]}]}}]},
]}


def apply(database) -> None:
    try:
        database.create_collection("incidents", validator=VALIDATOR, validationAction="error", validationLevel="strict")
    except CollectionInvalid:
        database.command("collMod", "incidents", validator=VALIDATOR, validationAction="error", validationLevel="strict")
