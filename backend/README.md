# backend/ — recovery agent, increment 1 (turn-based slice)

All flight data here is **SIMULATED**. Not an aviation-safety system. Owner of this folder: increment 1 work
(see `spec.md` §5). Add other workstreams in their own folders/modules rather than editing these files in place.

MongoDB is the single source of truth. Every fact the demo shows is read back from these collections:

| Collection | Holds |
|---|---|
| `incidents` | state machine, revision, approval (bound to flight/action/source version), command, resolution |
| `observations` | each read of source/display: status, `sourceTime`, `sourceVersion`, `observedAt` |
| `commands` | intent (written before send), ACK (separate), outcome |
| `turns` | committed turn, tool order, route trail, driver calls, latency; unique `(incidentId, turnId)` = dedup |
| `decisions` | one row per classifier boundary: route, reason, classifier release, evidence IDs, gate override |
| `sim_sources` `sim_displays` `sim_effects` | the labeled simulator; `sim_effects` is the effects ledger, unique per `commandId` |

Next (not built yet): `training_examples`, `classifier_releases`, `resolved_cases` (+ Vector Search), checkpoints.

## Layout
- `app/classifier.py` bootstrap router `bootstrap-v0` (rules, **not trained**, probability is `null`)
- `app/policy.py` deterministic gates: step/driver budgets, closure rule (`can_close`)
- `app/engine.py` turn loop, approval/reject, command handling (server-enforced)
- `app/driver.py` driver seam — **no model configured**; returns nothing, engine answers honestly
- `app/simulator.py` fake airline feed + display; reconnect never replays; receiver dedups by `commandId`
- `app/api.py` + `app/static/index.html` API and single-screen dashboard

## Run
```bash
# MongoDB on 127.0.0.1:27017 (or set MONGODB_URI / MONGODB_DB), then from backend/:
uv sync --python 3.12
uv run pytest -q
uv run uvicorn app.api:app --port 8000   # open http://localhost:8000
```
Use **New (ACK-only display)** to see an acknowledged refresh that never applies: the incident cannot close.
