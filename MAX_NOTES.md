# MAX_NOTES: Max's lane, for teammates and their agents

Owner: Max. Written for Rob's and Tamir's agents to read and reconcile against.
Updated: 2026-11-14. Detail and evidence: `docs/max-workspace-status.md`. The spec (`spec.md`) wins on conflict.

## What exists on main (Max)
| Path | What | Status |
|---|---|---|
| `apps/web` | Next.js workspace: live panels from change streams (SSE), lock / reject / correct / forget, actions & audit, Mermaid diagram, Ask Gomon (memory on vs off) | Works on real Atlas |
| `apps/connectors` | Outbox worker: `actions` -> GitHub issues / Slack thread, policy check first, idempotent, read-back to `confirmed` | Works on real GitHub + Slack |
| `docs/max-workspace-status.md` | Run commands, verified evidence, open items | Current |

Tests: `apps/web` 15, `apps/connectors` 12 (`npm test` in each; needs a local replica set or `MONGODB_URI`).

## Data contract the workspace assumes (Rob: please confirm or tell us the diff)
All reads filter `teamId` + `projectId`. Shapes are in `apps/web/lib/types.ts` and `apps/web/README.md`.
- `calls` `{ _id: callId, teamId, projectId, title, status, participants[], slackThreadTs? }`
- `utterances` `{ callId, seq, speaker, text, at }`
- `call_items` `{ callId, kind, text, status: proposed|locking|promoted|rejected, expiresAt (TTL), memoryId? }`
- `memories` `{ teamId, projectId, key?, kind, text, version, status: active|superseded|forgotten, origin: call|doc, sourceRefs[], supersedes?, lock?, embedding? }`
- `conflicts`, `timings`, `members { teamId, displayName, role }`, `policies { teamId, projectId, action, allowedRoles[] }`
- `actions` `{ type: create_issue|post_slack, status: queued|sending|sent|confirmed|failed|denied, idempotencyKey (unique), callId, payload, requestedBy, policyCheck, externalId? }`
- `audit_events` `{ teamId, projectId, callId?, at, type, actor, reason, ref }`

Writers: anyone may write `utterances`, `call_items`, `conflicts`, `timings`. Only `lib/governance.ts` (or Rob's
equivalent) should flip memory status, and only the connector worker sends externally.

## Retrieval (overlaps Rob's lane; tell us if you want it replaced)
- Vector index `memories_vector` on `memories.embedding`: 1024 dims, cosine, filters `status`, `teamId`, `projectId`.
- Embeddings: Voyage `voyage-4`, `input_type` document/query. `npm run embed` in `apps/web` creates the index and backfills.
- A correction drops the old vector (`correctMemory`), so the new text is re-embedded before it is searchable.
- `/api/ask` is vector-only. Rob's hybrid retrieval (vector + text) should replace `retrieve()` in `apps/web/lib/retrieval.ts`
  with the same signature: `(db, {teamId, projectId}, question, k) -> [{_id, key, kind, text, version, score}]`.

## Questions for Rob
1. **Databases.** We hear you are splitting a per-chat sample database from the main "brain". The workspace takes
   `MONGODB_DB` and scopes by team/project. Which database does a call's workspace read, and which writes are
   promoted into the brain? If promotion crosses databases it cannot share one transaction with its audit event.
   Max is on `gomon_max` on the shared cluster today; `gomon` is untouched.
2. **Memory keys.** Locked call decisions have no `key` (seeded doc memories have D-07, R-12...). Should lock assign
   the next `D-NN`? Ask Gomon and Slack cite keys when present.
3. **Agent loop -> actions.** Voice commands should write `actions` with `idempotencyKey = type:callId:memoryId:vN`
   so a voice "create the tickets" and a UI click do not double-send.
4. **Validators.** Connector tests already run under the spec's `actions` validator (sent requires
   `policyCheck.allowed` and `requestedBy`). Send yours and we will run the suites against it.

## LLM
- No LLM key yet. LangSmith key is valid (free tier) but has no model access (`llm_gateway_enabled: false`).
- `apps/web/lib/answer.ts` is ready: set `LLM_PROVIDER=anthropic`, `LLM_API_KEY`, optional `LLM_MODEL`
  (default `claude-sonnet-5-5`). Without a key, or on any LLM error, it falls back to quoting the top memory.

## Ownership (do not edit without asking)
Max: `apps/web/**`, `apps/connectors/**`, `docs/max-workspace-status.md`, `MAX_NOTES.md`.
