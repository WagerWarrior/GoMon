# apps/worker: Gomon agent worker (Rob)

Atlas schema, synthetic seed, hybrid retrieval, the per-utterance agent loop, consensus locks, and memory governance.
Atlas (hackathon sandbox, MongoDB 9.0.7) is the only state: utterances in, call items / conflicts / memories / says / actions /
audit / timings out. The web workspace and the bot page read the same collections.

```bash
cd apps/worker && npm install
npm run setup               # collections + validators, TTL/unique indexes, memories_auto (Automated Embedding) + memories_text
npm run seed                # synthetic Northwind team, members/roles, policies, design-doc memories; `-- --reset` wipes call data
npm run verify              # live checks: hybrid retrieval, exact IDs, cross-team isolation, validator, TTL
npm start                   # worker on :3001 (VOICE_OUT=recall npm start: the worker speaks into meetings itself)
npm run join -- <meet_url> [callId] [title]       # send Gomon to a meeting (Recall bot, transcript webhook via PUBLIC_BASE_URL, voice via Output Audio)
npm run say -- <callId> "<speaker>" "<text>"     # typed utterance (source "typed"), or `-- <callId> --script` to rehearse
npm run inspect -- <callId>                       # dump what Gomon wrote for a call
```
Reads the repo-root `.env` (`MONGODB_URI`, `LLM_API_KEY`, `TEAM_ID`, `PROJECT_ID`; see `.env.example`).

## Contracts

**Tamir (bot page / Recall):**
- `POST /api/utterances` `{ callId, sourceKey, speaker: { displayName }, text, source: "recall"|"scribe"|"typed", startedAt?, endedAt? }`
  Only final/committed segments. `sourceKey` = Recall segment id (dedup: re-posting the same key returns `{duplicate: true}`).
  `speaker.displayName` must match a `members` row for policy-gated commands (seeded: Rob/Robert Reder, Max/Max Naidenov, Tamir/Tamir Azbel).
- `GET /api/says/stream?callId=` SSE, `event: say` `{ sayId, text, priority: "high"|"normal", reason, createdAt }`. Replays queued says on connect.
- `POST /api/says/:sayId/ack` `{ status: "started"|"done"|"failed"|"cancelled" }`.
- `POST /api/calls` `{ callId?, title?, meetingUrl? }` → `{ callId }`. Calls are also created on the first utterance.
- Optional auth: set `WORKER_TOKEN`; send `Authorization: Bearer …` (or `?token=` on the SSE URL).

**Max (workspace / connectors):** shapes follow `apps/web/README.md`. Worker additions:
- `memories.key` is human-readable (`D-12`); promoted call memories get the next key per kind. `lock.via`: `consensus | voice | human`.
- `call_items.agreedBy[]`, `lockAnnouncedAt`, `vetoMs` drive the veto countdown; status `locking` → `promoted` (sweeper) or back to `proposed` (veto).
- `conflicts.kind`: `conflict | already_decided`; `conflicts.spoken` = Gomon said it out loud.
- `says` collection (Gomon's speech, with `reason` and ack `status`), `agent_events` (retrieved memory keys per utterance), `timings`
  stages `queue`, `retrieve`, `analyze`, `utterance_to_item`, `total`.
- `calls.memoryEnabled` (default true): `PATCH /api/calls/:id { memoryEnabled }` turns retrieval off for the A/B memory proof.
- Outbox idempotency key: `${type}:${callId}:${memoryId}:v${version}` (Max's proposed format, `type` = `create_issue|post_slack`),
  so voice and UI can never file the same decision version twice.
- Policy actions used: `lock_decision`, `correct_memory`, `forget_memory` (leads only), `create_issue`, `post_slack`.

## Agent templates (`agent_templates`, `calls.templateId`)
A template decides how Gomon behaves on a call; the worker reloads it every batch (5 s cache), so switching mid-call works.
| Field | Effect |
|---|---|
| `persona` | Added to the analysis prompt |
| `captureKinds` | Which call-item kinds are captured (others are dropped) |
| `proactivity` | `quiet`: speaks only when addressed (conflicts still recorded, `spoken:false`). `balanced`: 1 spoken conflict per batch, suggestions ≤ 1 / 5 min. `active`: 2 per batch, suggestions ≤ 1 / 2 min |
| `consensus` | `announce_veto`: "Locking in…" + veto window. `explicit_only`: locks only on "lock it in" or a workspace click |
| `vetoMs` | Veto window for consensus locks (3–60 s) |
| `voiceId` | ElevenLabs voice; stamped on every `says` row and in the SSE payload (`voiceId`). Bot page: use it when present |

Seeded: `design-review` (default), `silent-scribe`, `architecture-challenger`. Validator on the collection; unique `(teamId, name)`.
Endpoints (Max: for the templates page and the per-call dropdown):
- `GET /api/templates` list. `POST /api/templates` create, `PUT /api/templates/:id` update (`version` +1). Body: `{ actor, name,
  description, persona, proactivity, consensus, vetoMs, captureKinds[], voiceId? }`. Policy `manage_templates` (leads only);
  denials and changes are audited (`template_created`, `template_updated`, `policy_denied`). Invalid input → 400 with `details[]`.
- `POST /api/calls { callId?, title?, meetingUrl?, templateId? }`; `PATCH /api/calls/:id { templateId?, memoryEnabled?, actor? }`
  (`template_assigned` audit). Unknown template → 400.
Verified live: silent-scribe recorded D-12/R-12 conflicts without speaking and answered when addressed; design-review spoke one;
engineer create denied and audited; lead create succeeded; a template `voiceId` reaches `says`.

## Users and per-user calls (`users`, `user_sessions`)
- `users { _id, email, name, teamId, role, displayNames[], displayNamesLower[], passwordHash: "scrypt$…" }` (validator; unique email).
  Seeded (synthetic, password `gomon-demo` or `DEMO_PASSWORD`): `rob@gomon.dev` (lead), `max@gomon.dev`, `tamir@gomon.dev`.
- `user_sessions { _id: sha256(token), userId, expiresAt }` with a TTL index; the raw token is never stored.
- Calls get `ownerUserId` (creator) and `participantUserIds` (filled when a speaker's Meet display name matches `displayNames`).
  Visibility rule (use the same in the workspace): `{ teamId, $or: [{ ownerUserId: me }, { participantUserIds: me }] }`.
- `POST /api/auth/login {email,password}` → `{ token, user }`; `POST /api/auth/logout`; `GET /api/me`; `GET /api/me/calls`.
  Send the user token as `x-session-token` (the service `WORKER_TOKEN` bearer still applies). `POST /api/calls` sets the owner.

## Live state, links, grounding
- `calls.agentState { state: listening|thinking|searching|answering, detail, at }`, also streamed as `event: state` on
  `/api/says/stream` (bot tile: show it, don't speak it).
- "Hey Gomon, drop the GitHub link for D-15" → `share_link`: decision → its GitHub issue/Slack post from `actions.externalUrl`,
  "repo" → repo URL, else GitHub search (`GITHUB_TOKEN`), else latest link from the call. Posted to the meeting chat through
  Recall `send_chat_message` (bot id parsed from the Recall `sourceKey`), and always stored in `chat_messages`. Needs a sharing
  verb ("send/drop/share/post … link"); "what's the latest issue?" is answered in words.
- When addressed, the prompt also gets **workspace context** (`src/context.ts`): how long Gomon has been in the call, recent
  locked decisions with their call, previous calls with ≥10 utterances, the repo's latest GitHub issues/PRs (60 s cache), and
  Atlas memory counts. Each entry has a source id (`D-18`, `#14`, `call:<id>`, `atlas`).
- **Rolling call summary** (`src/summary.ts`): `calls.summary` / `summarySeq` / `summaryAt`, refreshed off the critical path
  every 12 utterances (previous summary + new turns, ≤120 words, thinking disabled), atomically claimed via
  `calls.summarizing`. Every analysis sees it as CALL SO FAR, so Gomon can recall the start of a long call (verified: "what did
  Tamir say about webhook retries at the start" answered from the summary, outside the 8-turn window).
- Replies carry `replyKind`: `conversational` (about the call itself: "can you hear me"), `grounded` (must list `sources`; at
  least one must be in the provided context and every spoken key must be active, else replaced with "I don't have anything on
  that yet." and logged as `ungrounded_reply_dropped`), or `no_answer`.

## Speech policy
| Situation | Voice | Elsewhere |
|---|---|---|
| Addressed ("hey Gomon …") | answer; "On it." only if the answer takes >1.5 s and the request has 5+ words | — |
| High-severity conflict (would break a locked decision / customer requirement) | once per memory per call, after a 1.5 s pause | conflicts panel |
| Medium/low conflict, already decided | silent | conflicts panel |
| Consensus lock announce / locked / held | silent (spoken only if meeting chat fails) | meeting chat + dashboard |
| Suggestions | only `architecture-challenger` template | agent_events |

## Voice out via Recall (`VOICE_OUT=recall`, `src/voice.ts`)
Each `says` insert for a call with `calls.botId` → ElevenLabs mp3 (`VOICE_MODEL`, default `eleven_v4_turbo`) → Recall
`POST /bot/{id}/output_audio/`. Bots must be created with `automatic_audio_output` (`npm run join` uses the greeting).
Per-call serial queue, lines older than 20 s dropped, `timings.stage = say_to_audio` (measured ~1.7 s). No barge-in on this path
(Recall clips can't be cut); the Output Media page (Tamir, PR #14) is the barge-in path. Run the bot page with `WORKER_URL=` so it
only relays webhooks and doesn't also speak.

## Answers to MAX_NOTES questions
1. **One database: `gomon`.** Call scratch (`call_items`, TTL) and canonical memory (`memories`) live in the same database, so
   promotion, its audit row, and outbox entries share one transaction. Please point the workspace and connectors at
   `MONGODB_DB=gomon` (setup + seed already ran there). The worker creates no per-chat database.
2. **Memory keys:** yes, lock assigns the next key per kind (`D-12`, `R-16`, …) via `counters`, continuing after the seeded keys.
3. **Idempotency:** adopted `type:callId:memoryId:vN`.
4. **Validators:** `scripts/setup.ts` (memories: active call memory needs `lock.lockedAt`, `lock.participants`, `lock.lockedBy`;
   actions: your sent/confirmed rule; call_items: kind/status enums). Already applied on `gomon`.
5. **Retrieval:** `gomon.memories` uses Atlas **Automated Embedding** (`memories_auto`, server-side Voyage `voyage-4`, field `text`)
   plus `memories_text` (Atlas Search) and `$rankFusion`. No client embeddings: a correction's new text is embedded by Atlas, so
   no re-embed step. To reuse it in `/api/ask`, port `src/retrieve.ts` (same filters; signature `(cols, {teamId, projectId}, q, k)`),
   or call the worker. `memories_vector` / `embedding` exist only in `gomon_max`.

## How a turn works
1. `POST /api/utterances` inserts; an Atlas change stream (resume token in `stream_offsets`) wakes the worker; a 15 s sweep catches misses.
2. Work is serialized per call and claimed once (`claimedAt`/`processedAt`).
3. `retrieve()`: `$rankFusion` of `$vectorSearch` (Automated Embedding, Atlas embeds the query with Voyage) + `$search` (lexical),
   both pre-filtered to `teamId`/`projectId`/`status: active`; exact IDs ("R-12") resolve via index; very fresh memories are read
   directly (search index lag guard).
4. One structured Claude call (`claude-haiku-5-5`, JSON schema): new items, conflicts, agreement, objection, command, reply.
5. Writes: call items (TTL), conflicts (high severity spoken once per 3 min), `locking` + announcement, veto, commands
   (lock/correct/forget/tickets/Slack) through policy-checked transactions with audit rows, replies as `says`.
6. A 1 s sweeper promotes `locking` items after the veto window (survives restarts).

## Verified
Live Google Meet (`checkpoint-2`, `live-meet-2`): Recall transcript → bot page → worker → Atlas; "flat 100, no bursts" flagged
against D-18/R-12 and spoken through Recall Output Audio (say → audio ~1.7 s). Typed (`npm run say`), after the speech-policy
change: "can you hear me" → conversational answer; "what did we decide in previous calls" → D-18/D-17 with call source;
"latest GitHub issue" → "#14, the open barge-in PR"; "how many memories in Atlas" → counts by kind; "remote work policy" →
"I don't have anything on remote work policy yet."; "maybe a sliding window" → medium conflict, silent.

Earlier typed runs:
- Flat-100 proposal → R-12 conflict spoken; per-request billing writes → D-09 / K-04 spoken.
- "Agreed, let's do that" → lock announced → promoted to D-12 after 10 s with lock proof and audit.
- "Create the tickets" → one queued `create_issue` action; "correct that, 3,000" → R-12 v2 supersedes v1.
- Fresh call: "why do enterprise tenants get burst?" answered from D-12 and corrected R-12.
- Engineer "forget A-01" denied and audited; lead allowed. Memory off: no conflict; memory on: D-12 + R-12 flagged.
- Measured (7 utterances): retrieve avg 437 ms, analyze avg 3.1 s, total avg 4.4 s. Analysis latency is the bottleneck.

## Not done
Barge-in on the Recall Output Audio path (clips can't be cut; use the Output Media page for that). Meeting-chat delivery
(`send_chat_message`) is coded but not yet observed in a live Meet.
