# MAX_NOTES: Max's lane, for teammates and their agents

Owner: Max. Written for Rob's and Tamir's agents to read and reconcile against.
Updated: 2026-11-14 (after Rob's worker landed). The spec (`spec.md`) wins on conflict.

## For Rob: floor fixes from Max's live test, 59dbd2a (16:11). Needs a worker restart + ears/session page reload
Max ran the demo and Gomon answered without its name. Evidence (call-202611142054-291b, `says` joined to their utterance):
"How can we resolve the EU residency question?", "What do you think we should do?" and "Thank you. How is it like?" got
`addressed` replies with no wake word (the analysis model set `addressed`), and the follow-up window answered "Is that a larf? Yeah, it".
1. **Wake word only** (`apps/worker/src/floor.ts` `gateToWake`, called in `agent.ts`): without a wake word in the batch the
   model's reply, command and GitHub op are dropped; items, conflicts, agreement and "wait" vetoes are untouched. The follow-up
   window is off by default; `FOLLOW_UP_MS=20000` turns it back on. The demo script says "Hey Gomon" on every line, so it is unaffected.
2. **Chime on wake** (`voice.ts` `heard`, called at ingest in `main.ts`): 0.36 s two-tone mp3 (`public/sounds/heard.mp3`) through
   Recall output_audio before any model call, Thinking card, `agentState.detail` "heard Rob, checking team memory", timing
   stage `wake_to_chime`. `HEARD_CHIME=off` disables the sound. Only with `VOICE_OUT=recall`.
3. **Barge-in** (`voice.ts` `stopSpeaking`, `floor.ts` `bargeIn`): "stop", 5+ words over Gomon, or 1.2 s of talk cuts the clip
   with Recall `DELETE /bot/{id}/output_audio/` (the endpoint answers 404 for an unknown bot and allows DELETE; a silent clip
   is the fallback), cancels waiting lines, writes `agent_events.kind: "barge_in"`. `/ears/partial` carries partial text from
   `public/ears.html` and the in-app `Listen.tsx` (proxy allows `partial`). Gomon's own voice is excluded by word overlap.
4. **Names are learned** (b2b9428, `people.ts`): a misheard name that sounds like exactly one person resolves to them
   ("Nade X0" -> naidx0, checked against the real `members`) and is saved as `members.aliases` / `users.aliases` with
   `agent_events.kind: "alias_learned"`. `/ears/token` now also returns `keyterms` (people, logins, projects) that both
   listeners pass to Scribe; a Scribe session with 8 keyterms started fine.
5. **Live feed** (3fbcabc, `apps/web/lib/mission.ts`): shows the chime, fast-lane answers, interruptions and learned names.
6. **End meeting** (383dcb4): button on the session page -> `POST /api/sessions/:id/end` writes `status: "ended"` +
   `endRequested: true`, cancels queued lines, audits. `main.ts` `watchEndRequests` (needs the restart) stops Gomon
   mid-sentence and calls `leaveBot`, so the click works from any laptop. With RECALL_API_KEY in the web's env it also
   tells Recall directly. Checked: unknown call 404; a real failed call ended from the button.
7. **Context window** (adf7e14 `window.ts`, wired into `fast.ts`): named sections with token budgets (header 150, call so
   far 250, open call items 300, team memory 500, workspace 700, past meetings 500, recent turns 700; ranked results keep
   the head, turns keep the tail). New in the window: OPEN CALL ITEMS; the prompt now names PAST MEETINGS AND ADRS as an
   allowed source (it was passed but the rules said "only TEAM MEMORY and WORKSPACE"). Each answer writes
   `agent_events.kind: "context_window"` with per-section tokens, lines cut and the API's real `usage`. The full
   analysis lane (`llm.ts`) is unchanged.
8. **Real speaker names, after the call** (`speakers.ts`, sweep in `main.ts` every 20 s): for calls ended in the last
   30 min, each spoken line is matched against Recall's speaker timeline (who held the floor while it was said) and
   `speaker.displayName` becomes the real participant; the old label stays as `speaker.heardAs`, audit `speakers_relabeled`.
   Live it is not possible without a public URL: a live bot's `speaker_timeline_download_url` is null and the legacy
   polling endpoints answer 400 (probed on your bots, read-only). Live names = set `PUBLIC_BASE_URL` (the realtime
   transcript mode in `recall.ts`). Not proven on real data: the only finished call with lines (call-202611142119-4727)
   has an empty timeline (nobody unmuted in the Meet?), so the dry run renamed 0 of 32. People must be unmuted in Meet.
Verified: worker typecheck 0, `npm test` 31/31 (`test/floor.test.ts`, `test/people.test.ts`, `test/window.test.ts`), web typecheck 0. **Not verified live**: I did not
start a second worker on the shared database or play audio into your meeting, so the chime and the DELETE are untested in a
real Meet. If the chime misbehaves, `HEARD_CHIME=off`.

## For Rob: answer path measured call by call, three waits removed (2026-11-14)
`cd apps/worker && npm run latency` times every call the fast lane makes (read-only, writes nothing). From Max's laptop:
one Atlas round trip ~100 ms, hybrid memory search ~330 ms, knowledge search ~400 ms, all context in parallel 400-900 ms,
Haiku reply 760-900 ms (first token is no earlier than the full reply at this length), ElevenLabs flash 530 ms.
Removed, each one Atlas round trip (~100 ms) that sat in front of something: the call read before the searches (`fast.ts`),
the bot lookup before the chime and before every line (cached 30 s), and the "started" write before the clip is sent (`voice.ts`).
The chime now goes out while the state line is written. Order is unchanged: chime -> search -> model -> voice -> clip.
**Restart the worker to pick it up. Not measured live:** no Recall key on Max's machine, and `timings` was empty (fresh reset).

## For Rob: Gomon's camera card is animated now (2026-11-14, 16:35)
`apps/worker/src/card.ts` draws each frame (SVG -> JPEG with `sharp`) in the dashboard theme and pushes it through the same
Recall Output Video call. Callers are unchanged (`showCard`). Thinking: three moving dots, a live timer and the `agentState.detail`
line. Speaking: voice bars. Locking: a ring that drains over the 10 s veto with the seconds left. Listening: one still frame.
- **To pick it up:** `git pull && cd apps/worker && npm i` (new dependency `sharp`), restart the worker. Without `npm i` it logs a
  warning and shows the still cards, nothing breaks.
- Frames go out every 0.6 to 1 s only while a state lasts; a 429 pauses the animation 3 s. Tests: `npm test` (22/22).
- **Not verified in a live Meet.** Unknown: how fast Recall swaps the image, and its rate limit on `output_video`.

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

## For Rob: "only activate on hey Gomon" (Max, Nov 14)
Decision: passive capture keeps running without the wake word; the wake word gates everything Gomon SAYS.
Capture is the governed record (call items, conflicts, consensus, memory, the dashboard); gating it would leave the
workspace empty and break Statement Two. The mode already exists: template `silent-scribe` (proactivity `quiet` =
0 spoken conflicts, no suggestions; consensus `explicit_only` = no spoken "Locking in" announcement). Asks for Rob:
1. Make `silent-scribe` the default (`DEFAULT_TEMPLATE_ID`), or let Max pick it per session on the Templates page.
2. Context memory: the agent's window is fixed (8 recent turns, 20 open items, top 6 memories, max_tokens 2048). Max wants
   a "nice context memory system": suggest per-template limits plus a rolling call summary stored on `calls`
   (refreshed every N turns) so the model sees the whole call, not the last 8 lines. The web UI already shows each run's
   recalled memories, latencies and decision, so whatever you store there will be visible.

## Memory is always on inside calls (Max, Nov 14)
No memory-off mode for Gomon in a call. Rob: drop the `memoryEnabled` branch in `agent.ts` (or ignore `false`) and the
`PATCH /api/calls/:id {memoryEnabled}` field; the web shows no toggle and will not add one. The on/off comparison stays
only in Ask Gomon (dashboard), outside calls, as the Statement Two proof.

## After-call recap + record (branch feat/meeting-recap, from Claude Meetings' summary email and docs)
When a call goes `status: "ended"`, the connector worker builds a recap from the governed record (no model call):
summary (`calls.summary`), Decided (keys), Tasks (T- keys), Changed in memory, Action items, Open questions,
Team memory pushed back (conflict -> memory key), Filed (links). It is stored on `calls.recap` `{ at, text, counts, requestedBy?, note? }`
(web: show it on the session page), posted once into the call's Slack thread (`recap:<callId>`), and filed as
`calls/<date>-<callId>.md` on the `gomon-records` branch (`doc:<callId>`, github op `write_doc`, never the default branch).

## For Rob, before the 16:10 reset (agent-loop audit, 15:20)
1. **`npm run seed -- --reset` deletes live calls.** `apps/worker/scripts/seed.ts:76-86` deleteMany's every call, utterance,
   timing, agent_event, memory and action for the team, not just seeded ones: LangSmith traced 34 utterances 19:50-20:14 UTC
   and only 8 still exist. Limit the reset to `synthetic: true` / `seed-*` ids, or record the demo call after the reset.
2. A failed batch is never retried (`main.ts:92-95`): marked processed with an error, nothing spoken, no `timings` row.
   One retry, then "I hit an error, say that again", and a `timings` stage `failed`.
3. Latency, ranked by measured cost (pull first: wake fix 34d98f4 in `wake.ts`, worker `npm test` 3/3, catches "Gomon" mid-turn):
   a. Head-of-line blocking: a turn waits behind the background batch in flight (queue 4.2-7.0 s on 4 turns). Two lanes
      per call: an addressed utterance runs at once; background capture batches stay serialized.
   b. Merge wait by source: Scribe already commits whole turns, so use ~300 ms for `source: "scribe"`, keep 1200 ms for Recall.
   c. Answer separate from capture: when addressed, a streamed text reply call speaks its first sentence as soon as it ends;
      the JSON capture call keeps running on the same batch (addressed analyze is 4-6.6 s today, plus say_to_audio 2.3 s).
   d. Prompt caching: `cache_control` on the system prompt + stable memory/workspace block (Haiku caches from 2048 tokens).
   e. Barge-in: stop Gomon's audio when someone else's partial passes 5 words; the reply keeps working.
   f. No LangGraph port before 5 PM; tracing already works.
4. LangSmith token usage is 0 on every run (raw fetch): return `body.usage` from `analyze` / set `usage_metadata`.
5. Connectors tests no longer touch Atlas (`MONGODB_TEST_URI` or local only); the 24 leftover `ctest_*` databases are dropped.

## Still open
1. Per-call sample database vs main brain: not in the repo; everything uses `gomon` today. If Rob splits it,
   tell us which database the workspace reads and how promotion crosses (it cannot share one transaction).
2. Atlas Admin API keys return 401 (the connection string works).
3. LangSmith key works for tracing only; the org has no model gateway.

## Ownership (do not edit without asking)
Max: `apps/web/**`, `apps/connectors/**`, `docs/max-workspace-status.md`, `MAX_NOTES.md`.
