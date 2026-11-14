# apps/web: Gomon workspace (Max)

Next.js page per call, updated live from MongoDB change streams over server-sent events. Atlas is the only source of truth;
the web app holds no state of its own.

```bash
cd apps/web && npm install
# uses MONGODB_URI / MONGODB_DB / TEAM_ID / PROJECT_ID from the environment (see root .env.example)
npm run dev          # http://localhost:3000 -> redirects to the latest call for TEAM_ID/PROJECT_ID
npm test             # governance transactions, policy, diagram (needs a replica set: transactions)
```

**Panels:** transcript, call items (veto countdown, Lock / Veto), canonical memory (Correct, Forget, version history,
forgotten greyed), conflicts, decision diagram (Mermaid, generated **only** from active memories), actions & audit
(requester, policy result, external ID), timings (p50/p95 from `timings`; empty until the worker logs them).

**Human actions follow the same rules as voice:** policy check (default-deny, role from `members`, rule from `policies`) then one
transaction that changes the record and writes its `audit_events` row. Correct = supersede (old version leaves `status: active`
immediately); Forget = tombstone with history. "Create tickets" / "Post to Slack" only **enqueue** `actions` with a deterministic
idempotency key; `apps/connectors` does the policy check and the send.

## Local development without Atlas
Transactions and change streams need a replica set. Single-node: `mongod --replSet rs0 ...` then `rs.initiate()`.
`npm run seed:dev` and `npm run sim` write **labeled synthetic** data into `gomon_dev` (they refuse the shared `gomon` DB unless
`FORCE_SEED=1`) so the UI can be built and shown before the voice pipeline exists. AGENTS.md forbids faking transcripts in the
live demo: use `sim` for development only.

## Collection shapes this app assumes (reconcile with Rob's schema / packages/shared)
| Collection | Fields read/written here |
|---|---|
| `members` | `{teamId, displayName, role}` |
| `policies` | `{teamId, projectId?, action, allowedRoles[]}` for `lock_decision`, `forget_memory`, `create_issue`, `post_slack` |
| `calls` | `{_id, teamId, projectId, title, status, participants[], startedAt, slackThreadTs?}` |
| `utterances` | `{callId, seq, speaker.displayName, text}` |
| `call_items` | `{callId, kind, text, status: proposed/locking/promoted/rejected, sourceUtteranceIds[], expiresAt, lockAnnouncedAt?, vetoMs?, memoryId?}` |
| `memories` | `{teamId, projectId, key?, kind, text, status: active/superseded/forgotten, version, supersedes, supersededBy, origin, sourceRefs[], lock{lockedAt, participants[], lockedBy, via}}` |
| `conflicts` | `{callId, itemId, memoryId, memoryKey, severity, spoken, note}` |
| `actions` | `{callId, teamId, projectId, type, payload, requestedBy, policyCheck{allowed,reason,policyId}, status, idempotencyKey, externalId, externalUrl}` |
| `audit_events` | `{callId?, teamId, projectId, at, type, actor, reason, ref}` |
| `timings` | `{callId, stage, ms}` |
Needs: unique index on `actions.idempotencyKey`. Promotion writes `lock.lockedAt`, `lock.participants`, `sourceRefs` so an Atlas
validator that requires them for active decisions accepts it.

## Not built / not measured
Presence and live cursors (stretch). No latency numbers are claimed: the Timings panel shows only what the worker logs.

## Ask Gomon: memory on vs off (Atlas hybrid retrieval)

`/api/ask` uses the same hybrid retrieval as the voice agent (Rob, `apps/worker/src/retrieve.ts`): `$rankFusion` over
`$vectorSearch` on `memories_auto` (Atlas Automated Embedding, Voyage server-side) and `$search` on `memories_text`,
pre-filtered to team, project and active; exact keys ("R-12") and memories updated in the last minute are added
directly. Memory off skips retrieval. With `LLM_PROVIDER=anthropic` + `LLM_API_KEY`, Claude answers from the cited
memories only (`lib/answer.ts`); otherwise the top memory is quoted. Each ask goes to `audit_events` with the cited IDs.
Indexes come from `cd apps/worker && npm run setup`. Secrets come from the repo-root `.env`, loaded by `lib/db.ts`.
