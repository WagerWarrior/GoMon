# Second demo: plan

**End state:** in a live Google Meet, Gomon never goes silent on a question, knows who is in the call, and the fraud
script runs start to finish without a stumble.

## What the first demo showed (call-202611142346-9d3f, Nov 14)

- Answers were right and fast (about 3 s), filing K-05 as issue 34 and assigning it to Max worked by voice.
- The silence: both first answers were cut after two seconds because the presenter kept narrating to the room. Every
  talk-over cut that day (4 of them) was narration, none a real "stop".
- Who is in the call came only from the names typed in the listener, never from Meet.

## Slices

| # | Slice | State | Gate |
|---|---|---|---|
| 1 | Talking over Gomon no longer cuts it; "stop" and its name still do. A cut answer is posted whole to the chat. | done, 3d164f0 | `npm test` (floor.test.ts) |
| 2 | Spoken keys (KL5, K5, K 05) read as K-05 | done, e0d5fbd | `npm test` (hold.test.ts) |
| 3 | Demo reset (`npm run reset:demo -- --apply`); seeded issues 27-32 count as filed, so no duplicates | done, 390fc64 | `npm test` (github-filed.test.ts), dry run lists exactly issue 34 |
| 4 | Read-only rehearsal: `npm run ask -- --demo` | done, 390fc64 | all five answers correct |
| 5 | Who is in the Meet, live: Recall `participant_events.join` / `.leave` to the worker's events server (127.0.0.1:3011, roster.ts) through `npm run tunnel`; `calls.liveParticipants`; a roll call in the chat; the listener's dropdown and "who is in this call?" read from it. If Recall refuses the events request, the bot is sent again without it | built: 26ce3eb, 42a41ee, and the join fallback | Recall-shaped events through the public tunnel (wrong token 401, worker API 404, joins/leave right, one roll call, answer right, listener updates in 6 s). Live, Nov 15 (call-202611150020-41d4): Recall's real join event arrived, roll call "Gomon here. In this call: Max Naidenov." sent to the Meet chat 5 s after Gomon entered |

| 6 | Live speaker labels: the bot also gets `speech_on`/`speech_off`; each listener line goes to whoever Meet says was talking (`speakerFor`), keeping `speaker.heardAs`; Meet names resolve to the team's full names ("Robert" -> Robert Reder); one entry per person across re-sent bots | built: 88daa12, 2f4fd6e | Through the tunnel on test-speech-2265: Robert's line labeled Robert Reder (heard as Max Naidenov), a line with nobody talking kept its label, double join listed once, leave removed him. Real Meet data (call-202611150020-41d4, downloaded after the call): 3 joins, 92 `speech_on` and 92 `speech_off` in the shape the parser reads; all 23 listener lines replayed to Max Naidenov, which is right because labels are per device and two people at one laptop are one speaker to Meet. With two devices in one room Meet's speaker flipped every ~0.3 s; a line whose window has more than 3 flips now keeps its typed label (roster.test.ts, built from those events). Not yet seen live: speech events arriving through the tunnel during a call, a real leave |

## Slice 5: how it runs

Start `npm run tunnel` in `apps/worker` before sending Gomon in; each bot reads the tunnel's URL from `.local/tunnel-url`
when it is sent. Cloudflare's quick tunnel answered 429 for minutes on the venue Wi-Fi, so the script falls back to
localhost.run over ssh (nothing to install). The tunnel reaches only the events server, never the worker API.
A free tunnel can stop forwarding mid-session (seen: localhost.run answered 502 with ssh still connected); the script
probes itself every 20 s and replaces a dead tunnel, but a bot already in a call keeps the old address, so start the
tunnel right before sending Gomon in.

## Why slice 5 needed a tunnel

Recall pushes join and leave events only to a public https address. On this Mac the bot runs without one (no tunnel),
and Recall's bot record has no participant list until the call ends (checked on the demo bot: `meeting_participants`
is absent, the participant file is released after the call). The tunnel exposes only the events server, for as long
as `npm run tunnel` runs; it accepts only `POST /recall/events/` carrying `RECALL_WEBHOOK_TOKEN`.

## Before the next demo

1. `npm run reset:demo` (dry run) then `npm run reset:demo -- --apply`: K-05 has no issue again.
2. `npm run tunnel` in `apps/worker`, left running: Gomon posts who is in the call when it joins.
3. `npm run check-keys` in `apps/bot-page`: every key answers (the Anthropic key hit its spending cap once on Nov 14).
4. `npm run ask -- --demo` in `apps/worker`: five correct answers.
5. Laptop on the venue Wi-Fi, not the phone hotspot (Atlas refuses the hotspot's address).

## Out of scope

Paid servers, a hosted deployment, and a second model provider as fallback.
