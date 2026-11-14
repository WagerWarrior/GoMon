# backend/ — recovery agent, increment 1 (turn-based slice)

All flight data here is **SIMULATED**. Not an aviation-safety system. Owner of this folder: increment 1 work
(see `spec.md` §5). Add other workstreams in their own folders/modules rather than editing these files in place.

MongoDB is the single source of truth. Every fact the demo shows is read back from these collections:

| Collection | Holds |
|---|---|
| `incidents` | state machine, revision, approval (bound to flight/action/source version), command, resolution |
| `observations` | each read of source/display: status, `sourceTime`, `sourceVersion`, `observedAt` |
| `commands` | intent (written before send), ACK (separate), outcome |
| `turns` | committed turn, tool order, route trail, reasoner calls, latency; unique `(incidentId, turnId)` = dedup |
| `decisions` | one row per classifier boundary: route, reason, classifier release, evidence IDs, gate override |
| `sim_sources` `sim_displays` `sim_effects` | the labeled simulator; `sim_effects` is the effects ledger, unique per `commandId` |

Next (not built yet): `training_examples`, `classifier_releases`, `resolved_cases` (+ Vector Search), checkpoints.

## Layout
- `app/classifier.py` bootstrap router `bootstrap-v0` (rules, **not trained**, probability is `null`)
- `app/policy.py` deterministic gates: step/reasoner budgets, closure rule (`can_close`)
- `app/engine.py` turn loop, approval/reject, command handling (server-enforced)
- `app/reasoner.py` reasoner seam — **no model configured**; returns nothing, engine answers honestly
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

## Learning loop (increment 3) — `app/learning/`
Offline, versioned, gated. Nothing is learned live. Data is derived from SIMULATED scenario families.

`python -m app.learning.run` (from `backend/`): **generate** oracle-labeled boundary snapshots (`training_examples`,
split by phrasing family) → **train** softmax classifier, fit/calibrate/threshold with leave-one-family-out CV on
train+validation only (`classifier_releases`, immutable, sha256 digest) → **evaluate once** on a frozen test split vs
always-reasoner and `bootstrap-v0` (`eval_reports`) → **promote** only if: zero unsafe early responses, no accuracy
regression vs bootstrap. A release is pinned per incident at open; a promotion affects new sessions only. The deterministic
policy gate runs on every release, and a learned route may only answer with the read-only status template unless the text is
an explicit close request.

Labels: oracle from the spec's evidence table (`oracle.py`), never reasoner output. Test splits are single-use: after a
test set is evaluated it is renamed `burned_testN` and never trained or tuned on again; promote against a fresh one.

### Results so far (real runs; see `eval_reports` for the stored records)
Frozen test sets were consumed in this order. **No release has been promoted; the active router is still `bootstrap-v0`.**
| Release | Frozen test | Result |
|---|---|---|
| `linear-a4f99355` | F5/F6 (burned_test1) | rejected: 21/114 unsafe early responses |
| `linear-ae92b92d` | F8/F9 (burned_test2) | rejected: 7/147 unsafe early; accuracy 0.761 < bootstrap 0.778 |
| `linear-ff7e0528` | F11/F12 (current test) | rejected: 0/147 unsafe, but accuracy 0.704 < bootstrap 0.778 (abstains to reasoner more) |

On the last set `bootstrap-v0` itself had 7/147 unsafe early responses (keyword false positives), so it would not pass the
safety gate either. Hash-n-gram linear models trained on ~870 templated examples do not beat keywords on new wording;
the real lever is more reviewed real turns (collected in `turns`/`decisions`). Not measured: reasoner latency, end-to-end
or voice latency (no reasoner/ElevenLabs configured). Classifier overhead only is reported.
