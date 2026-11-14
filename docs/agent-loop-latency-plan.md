# Gomon agent loop: map, measurements, and the low-latency plan

Branch `plan/agent-loop-latency` (not on main). Written 2026-11-14 by Max's session from the code at `ee60157`,
Atlas `gomon.timings`, LangSmith project `gomon`, docs.recall.ai, and small benchmarks run from Max's Mac.
Numbers marked *measured* come from those sources; everything else is labelled *estimate* or *docs*.

**End state (one sentence):** a person says "hey Gomon, …" and hears the first words of a grounded answer within
about 2.5 s of finishing the sentence, every stage traced in LangSmith with tokens and timings, and no stage able to
hang or silently drop the turn.

---

## 1. The loop today, stage by stage

```
speaker in Meet
  └─▶ Recall.ai bot (web_4_core) ── STT: recallai_streaming, mode prioritize_low_latency, en
        └─ webhook transcript.data (finals only) ─▶ apps/bot-page /recall/webhook/  (via Cloudflare tunnel)
              └─ POST worker /api/utterances ─▶ Atlas utterances (seq, speaker, text)
                    └─ apps/worker processPending: merge window (quiet 1.2 s, max 3.5 s; skipped if wake word)
                          ├─ parallel: last 8 turns + 20 open call items (Atlas finds)
                          ├─ parallel: retrieve() = $rankFusion($vectorSearch memories_auto [voyage-4 autoEmbed], $search memories_text) top 6
                          │            + workspace context (context.ts, 1.5 s timeout)
                          ├─ analyze(): ONE Anthropic call, claude-haiku-5-5, max_tokens 2048, json_schema output
                          │            → items, conflicts, agreement/objection, command, reply, suggestion
                          ├─ governance writes (call_items, conflicts, locks w/ veto, memories, audit_events, actions)
                          └─ say() → Atlas says (status queued)
                                └─ bot-page follows worker /api/says/stream (SSE) ─▶ page long-polls /say/poll
                                      └─ /tts/:sayId → ElevenLabs streaming TTS, eleven_flash_v2_5, mp3_22050_32, voice Matilda
                                            └─ audio plays in the bot's webpage → Recall output media → Meet
actions outbox → apps/connectors → GitHub issues / Slack (policy check, idempotent, read-back)
```

### Exactly which models do what

| Stage | Who runs it | Model / service | Where the call is made |
|---|---|---|---|
| Speech-to-text | Recall.ai cloud | `recallai_streaming`, `prioritize_low_latency`, `en` (Recall's own model; no custom vocabulary in this mode) | `apps/bot-page/scripts/create-bot.js` `recording_config.transcript` |
| Wake word | worker (local code) | sound-alike matcher, no model | `apps/worker/src/wake.ts` (port of `apps/bot-page/src/wake.js`) |
| Memory search embeddings | Atlas (server side) | Voyage `voyage-4` via Atlas Automated Embedding on `memories_auto` | `apps/worker/src/retrieve.ts` `$vectorSearch … model: config.embedModel` |
| Keyword search | Atlas Search | `memories_text` (BM25) | same `$rankFusion` |
| Thinking (extract, conflicts, consensus, commands, reply) | Anthropic | `claude-haiku-5-5` (`ANALYZE_MODEL`), one call per batch | `apps/worker/src/llm.ts` `analyze()` |
| Ask Gomon in the dashboard | Anthropic | `claude-haiku-5-5` (`LLM_MODEL`) | `apps/web/lib/answer.ts` |
| Text-to-speech | ElevenLabs | `eleven_flash_v2_5`, `mp3_22050_32`, voice `XrExE9yKIg1WjnnlVkGX` | `apps/bot-page/src/server.js` `/tts/:sayId` |
| Tracing | LangSmith | project `gomon` | `traceable()` on `gomon.handleBatch` and `gomon.analyze` only |

## 2. What it costs in time today

### Measured in the live loop (Atlas `timings`, last 6 h, n = 5 batches; LangSmith n = 49)

| Stage | p50 | p90 | max | Source |
|---|---|---|---|---|
| queue (utterance stored → batch claimed, includes merge window) | 1586 ms | 1594 | 1662 | Atlas |
| retrieve (hybrid search incl. Voyage query embedding) | 490 ms | 560 | 805 | Atlas |
| analyze (Haiku, full prompt + JSON) | 1953 ms | 2035 | 4670 | Atlas |
| analyze | 1713 ms | 2781 | 4668 | LangSmith (49 runs) |
| handleBatch (whole worker turn) | 2824 ms | 4993 | 6176 | LangSmith |
| total (worker, utterance → done) | 3254 ms | 3897 | 6039 | Atlas |

Note: `timings` held 830 rows earlier today and 21 now; someone cleared it. The sample is small. Re-measure after each change.

### Measured from Max's Mac (small benchmark, short prompt, 3 runs)

| Call | Result |
|---|---|
| Haiku 5.5 streamed, short prompt | first token 460–761 ms, done 852–1075 ms |
| Haiku 5.5 non-streamed | 974 ms |
| ElevenLabs `eleven_flash_v2_5` stream | first audio 224–315 ms |
| ElevenLabs `eleven_turbo_v2_5` stream | first audio 162–175 ms (faster here; re-test from the tunnel host before switching) |

So Haiku itself answers in under 1 s. The extra ~1 s in production comes from our prompt (system rules + memories + 20
items + 8 turns + workspace) and from waiting for the **whole JSON** (items, conflicts, consensus, reply) before anything is spoken.

### Spoken answer budget, end to end (estimate built from the rows above)

| Step | Now | Target |
|---|---|---|
| End of speech → Recall final transcript | 1–3 s (docs) | 0.5–1 s (partials + endpointing) |
| Webhook → bot-page → worker → Atlas | unmeasured (tunnel hop) | measure; < 150 ms |
| Queue / merge window | ~1.6 s for normal turns, ~0 for wake | 0 for wake (already), keep for passive |
| Retrieve | 0.5 s | 0.25 s (start on partials, cache) |
| Think | 1.7–2.0 s (whole JSON) | first spoken token ≈ 0.6 s (separate streamed reply call) |
| Say → page → TTS first audio | poll + ~0.25 s | ~0.2 s (turbo or flash, keep-alive, websocket TTS) |
| **Total "hey Gomon" → first audio** | **~5–7 s** | **~2–2.5 s** |
| Instant ack "On it." | pre-cached, fires after 1.5 s if the answer is slow | keep; fire at 0 when an answer is expected to be > 1 s |

## 3. Where it can fail (ranked by demo risk)

| # | Failure | What happens | Evidence |
|---|---|---|---|
| F1 | Anthropic call has **no timeout** and no retry/fallback | a slow or hung call stalls that batch; the call goes silent | `llm.ts` `fetch` without `signal`; only `context.ts` has `AbortSignal.timeout(1500)` |
| F2 | Reply is buried in a JSON blob with `stop_reason` must be `end_turn` | any truncation/schema miss drops the whole turn (items AND reply) | `llm.ts` throws `analysis incomplete` |
| F3 | Recall low-latency STT mishears "Gomon" and names (D-12, Acme) | wake missed or wrong memory; no custom vocabulary in this mode | `wake.js` comment, Recall docs |
| F4 | Single Cloudflare quick tunnel carries webhooks, page, polling and TTS | tunnel restart = deaf and mute bot; URL changes on restart | bot-page README / `PUBLIC_BASE_URL` |
| F5 | Says replay after outages | old says spoken late (fixed today in `4224ad0`, cancel stale) | git log |
| F6 | Two workers on one call | duplicate analysis/speech | claims by token + `WORKER_ID` (b0b266a) mitigate; verify with two processes |
| F7 | LangSmith sees only 2 spans, no tokens | cannot tell where time or money goes; no per-stage trace for STT/retrieve/TTS | 98 runs, `total_tokens` empty |
| F8 | ElevenLabs/Anthropic key revoked or rate-limited | mute or brainless bot | keys live in `.env.example` on a repo that may go public |
| F9 | `timings` gets cleared / unindexed | dashboard p50 lies | 830 → 21 rows today |
| F10 | Merge window adds 1.2–3.5 s to passive capture | conflict callouts late | `MERGE_QUIET_MS`/`MERGE_MAX_MS` |

## 4. The plan (slices, each gated on its own)

Order: S1 → S2 → S3 are the latency core and independent of each other's files except where noted. S4–S6 harden.
Owners per AGENTS.md: worker = Rob, bot-page = Tamir, web/connectors = Max. Nothing here edits another lane without that owner's yes.

### S1. Guard the model call (Rob, `apps/worker/src/llm.ts`) — first shippable slice
- `AbortSignal.timeout(6000)` on the Anthropic fetch; one retry on 429/5xx/timeout with 300 ms jitter.
- On final failure: record `timings{stage:"analyze_failed"}`, speak "Give me a second, I lost that." only if addressed, release the claim so the batch is retried once.
- Return `usage` to LangSmith (`run.extra.usage` / `usage_metadata`) so tokens show.
- **Gate:** unit test with a fake fetch that hangs → batch finishes in < 6.5 s with the failure recorded; LangSmith run shows `prompt_tokens`.

### S2. Speak first, analyze second (Rob `llm.ts`/`agent.ts`, Tamir for streaming say)
- When the batch contains the wake word, fire **two calls in parallel**:
  1. `reply()` — streamed Haiku call, small prompt (question + top memories + last 3 turns), plain text, `max_tokens` 200, cites keys inline.
  2. `analyze()` — today's JSON call for items/conflicts/commands, unchanged.
- Stream `reply` sentence by sentence into `says` (first sentence as soon as it ends) so TTS starts at ~0.6 s instead of ~2 s.
- Commands (lock, tickets, correct, forget) still come only from `analyze()`; `reply` never acts. Grounding check stays on the final text.
- **Gate:** scripted "hey Gomon, what did we decide on burst limits?" → `timings.first_say_ms` p50 < 1.2 s after claim, 10 runs.

### S3. Cut the front of the pipe: transcription (Tamir, `create-bot.js` + webhook)
- Subscribe to `transcript.partial_data` as well. Use partials **only** for: wake detection (pre-warm), starting `retrieve()` early, and the instant ack. Utterances and actions stay finals-only (AGENTS.md rule).
- Add keyterms. Try `deepgram_streaming` (nova-3, `keyterm: ["Gomon","D-12","Acme","token bucket"]`) or `assembly_ai_v3_streaming` / `elevenlabs_streaming` against the current `recallai_streaming` on the same recorded 2-minute script; pick by wake-hit rate and final latency. Third-party providers need their API key added in the Recall dashboard (Max/Tamir: account action).
- Optional: `diarization.use_separate_streams_when_available: true` for exact speakers (docs: up to ~1.8x STT cost).
- **Gate:** same script, 20 wake attempts: wake hit rate ≥ 95 %, median end-of-speech → final transcript measured from the webhook timestamps.

### S4. Faster retrieval and prompt (Rob, `retrieve.ts`, `llm.ts`)
- Start `retrieve()` on the wake partial (S3) so it is done before the final arrives.
- Shrink the analyze prompt: 20 open items → only items touched in the last 5 min + the 5 newest; workspace lines only when the question mentions issues/repo/previous calls.
- Use prompt caching (`cache_control` on the system block; it is static per template) to cut input-token latency.
- Context memory upgrade (Max's ask): a rolling call summary on `calls.summary`, refreshed every ~10 turns by a background Haiku call, replaces "last 8 turns only"; limits move into the agent template.
- **Gate:** analyze p50 < 1.2 s on the same script; retrieve p50 < 300 ms after warm-up.

### S5. Make the voice path robust (Tamir, `apps/bot-page`)
- Named Cloudflare tunnel (stable URL) instead of a quick tunnel, or deploy bot-page to a host with a fixed URL.
- Keep-alive HTTP agent to ElevenLabs; test `eleven_turbo_v2_5` vs `eleven_flash_v2_5` from the bot-page host and keep the faster one; consider the ElevenLabs WebSocket input-streaming API to feed S2's sentences as they arrive.
- Measure and store `say_to_audio_ms` (say created → first audio byte played, page acks).
- **Gate:** say → first audio p50 < 400 ms over 20 says; bot survives a tunnel/process restart without a new Recall bot.

### S6. LangSmith as the control panel (Rob worker, Max web)
- One trace per batch with child spans: `stt_final` (Recall timestamps), `queue`, `retrieve`, `context`, `reply`, `analyze`, `governance`, `say`, `tts_first_audio`. Metadata: `callId`, `templateId`, `addressed`, `model`.
- Feedback key `spoke_ok` written by the bot page ack; eval dataset = the scripted demo call (spec §8) with expected items/conflicts/locks, run on every prompt change.
- **Gate:** one demo call shows all spans in LangSmith; a dataset run reports item precision and the latency per span.

### Stated edge (out of this plan)
Barge-in, multi-language, self-hosted STT/LLM, running our own media bot instead of Recall, production auth.

## 5. What Max can decide now
1. Approve S1 + S2 for Rob (biggest win, smallest risk). 2. Add a Deepgram (or AssemblyAI) key in the Recall dashboard so S3 can compare providers. 3. Keep keys out of `.env.example` before any public flip (F8).
