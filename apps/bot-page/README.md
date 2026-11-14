# apps/bot-page: Gomon's ears and mouth (Tamir)

A zero-dependency Node server (Node >= 20.6) that puts Gomon in a Google Meet through a Recall.ai bot:

- **Ears:** Recall's real-time transcript webhook becomes one utterance per finished sentence, posted to the worker.
- **Mouth:** the worker's says are spoken in the Meet with ElevenLabs, through a page that runs as the bot's camera.

```bash
cd apps/bot-page
npm test                          # 35 tests, no network
npm run dev                       # server on :8787 (reads the repo-root .env)
npm run create-bot -- <meet_url>  # send the bot into a Meet; admit "Gomon" when Meet asks
npm run say -- "text" [normal|high] [callId]   # make Gomon speak without the worker
npm run sink                      # stand-in utterance API on :3999 (see "Testing without the worker")
```

## How it connects to the worker (apps/worker)

The bot page runs in Recall's cloud browser and cannot reach the worker, so this server sits between them.

| Direction | What this server does |
|---|---|
| Speech in | `POST {WORKER_URL}/api/utterances` with `{ callId, sourceKey, speaker: { displayName }, text, startedAt, endedAt, source: "recall" }` |
| Speech out | Follows `GET {WORKER_URL}/api/says/stream?callId=` for every call that has a bot page, and speaks each `say` |
| Acks | `POST {WORKER_URL}/api/says/:sayId/ack` with `started`, `done`, `failed` or `cancelled` |

`WORKER_TOKEN`, when set, is sent as a bearer token on all three. The worker needs no changes.
A say that arrives while the bot page is reconnecting is held for up to 30 s, then acked `cancelled`.
A `high` priority say drops lines that are queued but not yet spoken (those are acked `cancelled`).

## What the worker should know about the transcripts

Measured in a live Meet on 2026-11-14 with Recall's low-latency transcription:

- **Text is lowercase with no punctuation**, for example `i'm doing the i'm talking to you right now`.
- **Recall never spells "Gomon".** Heard instead: `goman`, `gonman`, `gourmand`, `so man`, `go on`, `no man`.
  That mode has no custom vocabulary. `src/wake.js` (`parseWake(text)`) matches the name by sound and expects
  people to say **"Hey Gomon"**; it has no dependencies and can be copied into the worker.
- **`speaker.displayName` is the Meet display name** (for example `Tamir Azbel`).
- **`sourceKey`** is `recall:<botId>:<participantId>:<segment start seconds>`. Recall has no per-segment id.
- **Times:** Recall sends only seconds since the recording started, so `startedAt`/`endedAt` are estimated from
  the first segment's arrival and can be off by Recall's delay (about a second). Their order is exact.
- **Gomon's own voice did not come back as an utterance** in the calls tested.

## Measured latency (same Meet, not a benchmark)

| Stage | Result |
|---|---|
| Speaker stops talking to utterance received here | median 0.8 s, range 0.5 to 3.4 s (53 utterances) |
| Say received to audio starting in the bot's page | 323 to 401 ms (4 samples) |
| of which ElevenLabs first byte | about 210 ms |

Audio generation starts the moment a say arrives, and finished lines are cached by text, so a repeated line
(or one listed in `SAY_PRECACHE`) needs no ElevenLabs request.

## Recall facts checked against docs.recall.ai

- The webhook URL needs a `/` before the query string (`/recall/webhook/?callId=`), or Recall answers 400.
- Recall retries any non-2xx 60 times at 1 s and then stops delivering for that call, so the webhook always
  answers 200 once the signature is valid, and skips redeliveries itself.
- Requests are signed with the workspace secret (`RECALL_WEBHOOK_SECRET`, `whsec_...`); the headers are only
  sent once that secret exists in the Recall dashboard. `RECALL_WEBHOOK_TOKEN` (`?token=`) is the fallback.
- `prioritize_low_latency` requires `language_code: "en"`. The default mode delays transcripts by minutes.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Bot page (Recall Output Media camera). `?callId=` ties the page to one call |
| `POST /recall/webhook/?callId=` | Recall `transcript.data` events |
| `POST /say` | `{ sayId?, text, priority?, callId? }`. Without `callId` every open page speaks |
| `POST /say/cancel` | Drop queued, unspoken lines |
| `GET /say/poll?client=&callId=` | Long-poll used by the bot page. Answers as soon as there is something to say |
| `GET /say/stream` | SSE alternative. Cloudflare quick tunnels do not deliver SSE, which is why the page polls |
| `POST /page/reload` | `{ callId? }` makes connected pages reload, to pick up a new page without a new bot |
| `POST /page/report` | The page posts its measured layout here (logged), to debug rendering inside Recall's browser |
| `POST /say/ack` | The page reports `started`, `done`, `error`, `cancelled` |
| `GET /tts/:sayId` | Audio for a say (the ElevenLabs key stays on the server) |
| `GET /health` | Pages, worker bridge state, counters |

## Testing without the worker

`WORKER_URL= UTTERANCE_API_URL=http://localhost:3999/api/utterances npm run dev` with `npm run sink` prints
every utterance. `SINK_AUTOREPLY=1 npm run sink` adds a test responder that answers "Test reply, ..." when
Gomon is addressed. It is a development tool, not the agent, and must not be used in the demo.

## Not done

- The worker bridge ran against the real worker in a Meet on 2026-11-14: a spoken question was answered aloud from team memory.
- Scribe fallback (mic plus ElevenLabs Scribe) is not built.
- Public URL: `cloudflared tunnel --url http://localhost:8787` keeps one address while it runs, but it delivers each
  audio clip only when the clip is complete and does not pass SSE. localhost.run streams, but changed its address
  after about 20 minutes, which silently disconnects the bot.
- `/?calibrate=1` on the page URL draws a test pattern, to see how a meeting crops the bot's camera.

## Gomon's face (Max, design)

The page shows Gomon's live leaf avatar (`public/gomon-avatar.js`, served at `/gomon-avatar.js`). It is built by `design/gomon/build.mjs` from `apps/web/lib/gomon`, so the bot page and the workspace share one set of states. The face goes muted while offline, listens by default, speaks with voice bars, and shows the 10 s ring when the spoken line announces a lock. Rebuild after changing the states: `cd design/gomon && npm i && npm run build`.
