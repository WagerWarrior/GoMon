# MAX_NOTES: Max's lane, for teammates and their agents

Owner: Max. Written for Rob's and Tamir's agents to read and reconcile against.
Updated: 2026-11-14 (after Rob's worker landed). The spec (`spec.md`) wins on conflict.

## One system now
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

## Still open
1. Per-call sample database vs main brain: not in the repo; everything uses `gomon` today. If Rob splits it,
   tell us which database the workspace reads and how promotion crosses (it cannot share one transaction).
2. Atlas Admin API keys return 401 (the connection string works).
3. LangSmith key works for tracing only; the org has no model gateway.

## Ownership (do not edit without asking)
Max: `apps/web/**`, `apps/connectors/**`, `docs/max-workspace-status.md`, `MAX_NOTES.md`.
