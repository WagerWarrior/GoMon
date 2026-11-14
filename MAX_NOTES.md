# MAX_NOTES: Max's lane, for teammates and their agents

Owner: Max. Written for Rob's and Tamir's agents to read and reconcile against.
Updated: 2026-11-14 (after Rob's worker landed). The spec (`spec.md`) wins on conflict.

## For Tamir (and his agents): barge-in decision needed (2026-11-14)
Gomon talks over people in Meet: the bot only hears finished sentences, and `cancel` never stops the current line.
Plan with research and four slices: `docs/listening-behaviour-plan.md`. Slice 1 is built as **draft PR #14**
(`feat/barge-in`, `apps/bot-page` only, 38/38 tests pass, not yet tried in a live Meet).
- **What it does:** subscribes to Recall `participant_events.speech_on`. A person starting to talk sends `stop` to the page,
  which pauses the audio and acks `cancelled`. The bot's own participant (`BOT_NAME=Gomon`) is ignored. `BARGE_IN=0` turns it off.
- **Decide one of:** (a) take it now: review #14, run one live Meet, merge; (b) not now: Max stops and nothing in
  `apps/bot-page` changes before the 5 PM submission. Max's lane touches nothing else in `apps/bot-page` until you answer.
- **Open questions for a live call:** does Recall report the bot as a speaker named "Gomon"? How long from a person
  starting to talk until the audio stops?
- Slices 3 (visible searching state) and 4 (spoken replies must cite a memory key) are in `apps/worker` (Rob's lane) and wait for both of you.

Everything runs on the shared Atlas cluster, database **`gomon`** (Rob's setup + seed). `gomon_max` was Max's
scratch database and is no longer used.

| Piece | Owner | Reads / writes in `gomon` |
|---|---|---|
| `apps/bot-page` | Tamir | Recall transcript webhook -> `utterances`; speaks `says` |
| `apps/worker` | Rob | `utterances` -> `call_items`, `conflicts`, `says`, `memories` (consensus lock, correct, forget), `actions` |
| `apps/web` | Max | Live workspace on change streams; human lock / reject / correct / forget; Ask Gomon; enqueues `actions` |
| `apps/connectors` | Max | `actions` -> GitHub issues / Slack thread, policy check first, read-back to `confirmed` |

Verified end to end on `gomon`: an action queued by Rob's voice agent was sent by the connector worker
(GitHub issue #6, policy `role engineer may create_issue`, status `confirmed`).

## Schema: web now matches apps/worker
- Lock assigns the next key from `counters` (`team/project/D` …), same scheme as `nextKey` in the worker.
- `sourceRefs: [{ type: "call", callId, itemId: ObjectId, utteranceIds: ObjectId[] }]`, `lock.via: "human"`,
  `updatedAt` on every write (the worker's fresh-memory guard reads it), audit type `memory_locked`.
- Corrections check the `correct_memory` policy; forget checks `forget_memory`.
- `actions.idempotencyKey = type:callId:memoryId:vN` and the same payload text as `enqueueForCall`, so voice
  "create the tickets" and a UI click file each decision version once.

## Retrieval: one implementation
`apps/web/lib/retrieval.ts` is a port of `apps/worker/src/retrieve.ts`: `$rankFusion` of `$vectorSearch` on
`memories_auto` (Atlas Automated Embedding) and `$search` on `memories_text`, team/project/active pre-filter, plus
exact keys and the fresh guard. Web no longer stores client-side vectors; the `memories_vector` index is gone.
If Rob changes ranking, mirror it there (or we extract a shared package after the demo).

## Ask Gomon (memory on vs off), live on `gomon`
Proposal "flat 100 req/s, no bursts, including Acme":
- Memory on (Haiku, ~2 s): "This conflicts with D-12 … and with R-12 …", cites D-12, R-12, R-14, R-15 (via text + vector).
- Memory off: generic advice, no team decisions cited.
LLM: `LLM_PROVIDER=anthropic`, `LLM_API_KEY` in `.env.example`, default model `claude-haiku-5-5` (`LLM_MODEL` overrides).

## Workflows (automation chains), backend in apps/connectors
`workflows` `{ teamId, projectId, name, trigger: "memory_locked"|"memory_corrected", steps: [{ type: "post_slack"|"create_issue" }], enabled, enabledAt, createdAt, updatedAt, createdBy }`
`workflow_runs` `{ workflowId, workflowName, teamId, projectId, trigger, eventId (audit_events._id), callId, memoryId, memoryKey, actor, firedAt, status: "fired"|"skipped", note?, steps: [{ type, actionId, idempotencyKey, duplicate }] }` (unique on workflowId+eventId)
- The connector worker watches `audit_events` for `memory_locked` / `memory_corrected` (from the workspace AND the voice agent) and
  fires each enabled workflow once. Steps only enqueue `actions` (same `type:callId:memoryId:vN` keys), so the outbox still checks
  policy as the person who locked, and a workflow + a click + a voice command send each decision version once (`duplicate: true`).
- Only events after `enabledAt` fire; doc memories are logged as `skipped` with a reason. Each firing also writes `workflow_fired` to `audit_events`.
- Default for the demo team: "Decision locked -> Slack + GitHub" (`cd apps/connectors && npm run workflows:seed`). Live on `gomon`:
  locking D-14 on call `workflow-test-1` fired it; Slack post and GitHub issue #7 both `confirmed`.
- Toggle = update `enabled` (set `enabledAt: new Date()` when turning on, so old events do not back-fire). Status of each step = join `actionId` to `actions`.

## Slack channel: #agent-drop (C0CHU319A2V)
Gomon posts to #agent-drop (Max, Nov 14; any worker with an old SLACK_CHANNEL_ID must pull and restart). Two connector workers on `gomon` are safe together (atomic claim, each action sent once), and a worker only claims action types it has config for (no `GITHUB_TOKEN` = it never touches `create_issue`), so a half-configured worker cannot fail another's send. Live: D-16 on call `workflow-test-1` -> #agent-drop thread + GitHub issue #10.
The Gomon app icon in Slack is the leaf face (`design/gomon/gomon-icon.png`, rebuilt by `node design/gomon/icon.mjs` + headless Chrome).

## Still open
1. Per-call sample database vs main brain: not in the repo; everything uses `gomon` today. If Rob splits it,
   tell us which database the workspace reads and how promotion crosses (it cannot share one transaction).
2. Atlas Admin API keys return 401 (the connection string works).
3. LangSmith key works for tracing only; the org has no model gateway.

## Ownership (do not edit without asking)
Max: `apps/web/**`, `apps/connectors/**`, `docs/max-workspace-status.md`, `MAX_NOTES.md`.
