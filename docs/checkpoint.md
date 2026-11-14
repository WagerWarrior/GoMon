# Checkpoint 14:55: what works, who does what until the 16:15 freeze

## Rules until submission
- **One live instance: Rob's laptop** runs worker, bot page, connectors and web, all from `main`. Nobody else starts a worker,
  connectors, or an auto-redeploy loop against database `gomon`. Two workers split sentences between them and break consensus;
  a second connectors process races the outbox. To try something, use typed utterances against Rob's worker
  (`npm run say -- <yourCallId> "<you>" "<text>"`), or your own database (`MONGODB_DB=gomon_<name>`).
- **Now:** a worker on `Tamirs-MacBook-Pro` (old code) still claims utterances: 9 of 15 in a 14:47 test, with the old spoken
  "Locking in" lines. Stop it. Rob stopped the `MongoDbHackathon-dev` watcher and stack on his laptop (it restarted on every push).
- One owner per folder: `apps/worker` + `seed` Rob, `apps/bot-page` Tamir, `apps/web` + `apps/connectors` Max. Pull before
  you push; small commits.
- Don't add keys to `.env.example` that GitHub's push protection blocks (GitHub tokens). Share those in Slack.

## Answers to MAX_NOTES (14:42)
1. `silent-scribe` stays opt-in, not the default: its `explicit_only` consensus never locks on agreement (demo step 4) and it
   never voices a serious conflict. `design-review` now gates speech on the wake word, except a high-severity conflict.
2. Context memory shipped: rolling `calls.summary` every 12 utterances, fed into every analysis; plus previous calls, recent
   locks, GitHub issues and Atlas counts when addressed. Show `calls.summary` in the session view.

## Verified (live Google Meet, Rob's laptop)
- Recall bot joins and greets; transcript webhook → bot page → worker → Atlas in real time.
- "Flat 100, no bursts" → spoken once: "D-18 locks enterprise bursts at 3,000 a second… flat 100 breaks that."
- Voice through Recall Output Audio (`VOICE_OUT=recall`, ElevenLabs `eleven_v4_turbo`); say → audio ≈ 1.7 s.
  Free tunnels (Serveo, Pinggy, ngrok) put a browser warning page in front of the Output Media camera page; this path avoids it.
- Speech policy (typed checks): conversational answers, grounded answers citing previous calls / GitHub `#14` / Atlas counts,
  "I don't have anything on that yet." when nothing covers it, medium conflicts silent. Details: `apps/worker/README.md`.
- Dashboard live session, connectors filing GitHub issues and Slack posts on lock (issue #9 earlier).
- **15:30 change: no tunnel.** Pinggy dropped mid-call (closed by its server after 2 min 46 s), which stopped transcription.
  Ears are now ElevenLabs Scribe from `http://localhost:3001/ears?callId=…` on the laptop in the Meet (tab audio + mic),
  wake word spelled right via `keyterms`. Recall only joins for voice and chat, both outbound.
- Utterances are held by the worker that ingested them (`heldBy`), so stray workers can't split a call: verified while
  Tamir's old worker was still running.

## Not yet seen live
Consensus lock → GitHub + Slack from **spoken** agreement with two people; meeting-chat link delivery; voice correct/forget;
memory on/off proof in the UI.

## Next, by owner
**Rob (worker, demo runner)**
1. Two-person live rehearsal of the full spec §4 script; fix what breaks.
2. 16:10: `npm run seed -- --reset` (clears rehearsal locks/corrections and test calls), restart worker.
3. Run the demo machine; record the 1-minute video with the team.

**Max (web, connectors)**
1. Session view: show each Gomon reply's `replyKind` and `sources` (`agent_events.analysis`), lock progress from
   `chat_messages`, `calls.agentState` as the live status, and conflicts marked spoken or silent.
2. Memory on/off toggle per call (`PATCH /api/calls/:id {memoryEnabled}` on the worker, or the same field in Atlas) for the
   Statement Two proof.
3. Login (`POST /api/auth/login`, `x-session-token`, `GET /api/me/calls`): each user sees only their calls. Users: `rob@`,
   `max@`, `tamir@gomon.dev`, password `gomon-demo`.
4. Stop any auto-redeploy loop or workers on your machine pointing at `gomon`.

**Tamir (bot page, voice)**
1. Barge-in (PR #14) only works on the Output Media page, which needs a tunnel without a browser warning page. If your ngrok
   account serves the page cleanly, verify it in a Meet and tell Rob; otherwise we demo with `VOICE_OUT=recall`.
2. Check whether Recall can stop a playing Output Audio clip (that would give barge-in on the current path). Tell Rob; the
   worker side is small.
3. Keep `npm test` green; the bot page now runs as a webhook relay (`WORKER_URL=` empty).

## Submission (16:45)
Make the repo public, upload the video, submit on Cerebral Valley with all three members, rotate every key afterwards.
