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
| 5 | Who is in the Meet, live: Recall `participant_events.join` / `.leave` to the bot-page webhook, then the worker keeps `calls.liveParticipants`; Gomon posts "In this call: …" in the chat when it joins; the listener's speaker list and "who is in this call?" read from it | needs a public URL | fixture events through the signed webhook; one real Meet with two people |

## Slice 5 needs one decision

Recall pushes join and leave events only to a public https address. On this Mac the bot runs without one (no tunnel),
and Recall's bot record has no participant list until the call ends (checked on the demo bot: `meeting_participants`
is absent, the participant file is released after the call). The free route is a Cloudflare quick tunnel
(`cloudflared tunnel --url http://localhost:<bot-page port>`): no account, no warning page, a new URL each run. It
exposes the bot-page server to the internet for the length of the demo; webhooks are signature-checked
(`RECALL_WEBHOOK_SECRET`).

## Before the next demo

1. `npm run reset:demo` (dry run) then `npm run reset:demo -- --apply`: K-05 has no issue again.
2. `npm run check-keys` in `apps/bot-page`: every key answers (the Anthropic key hit its spending cap once on Nov 14).
3. `npm run ask -- --demo` in `apps/worker`: five correct answers.
4. Laptop on the venue Wi-Fi, not the phone hotspot (Atlas refuses the hotspot's address).

## Out of scope

Paid servers, a hosted deployment, and a second model provider as fallback.
