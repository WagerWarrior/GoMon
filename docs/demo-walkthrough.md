# Demo walk-through: one real use case on the live data (Max, 2026-11-14)

The call is a design review for **Enterprise SSO** (Globex). It shows, in about three minutes: Gomon knows where it is,
remembers what the team locked, reads the GitHub tickets, catches a clash with a locked decision, locks a new one, files
its ticket, and stops when told. Every line starts with "Hey Gomon" (it only answers to its name).

**Before:** worker running with the current `.env`, Gomon admitted to the Meet, the listen page open and started, headphones on.
Join the call under the project `enterprise-sso`. Open the Meet chat: links and the answer trace land there.

| # | Say | What Gomon does | Checked |
|---|---|---|---|
| 1 | "Hey Gomon, what meeting are we in right now?" | Names the call, the Enterprise SSO project, Globex's Q1 2027 renewal, how long it has been in | answer, today |
| 2 | "Hey Gomon, what did we discuss in previous meetings?" | Globex SSO kickoff: D-16 (buy SAML and SCIM through WorkOS), R-16, T-03 | answer, today |
| 3 | "Hey Gomon, can you look at D09?" | Reads D-09 (no synchronous per-request writes to billing), says its ticket is issue 25, assigned to Robert; the link appears in the Meet chat, not in the voice | answer, today |
| 4 | "Hey Gomon, do we have any open tickets?" | Eight open issues, 18 through 25; two came from memory (25 from D-09, 24 from D-17) | answer, today |
| 5 | (no name) "Easiest is to put Globex in its own separate EU cluster." | Speaks without being asked, once: that clashes with D-17 (one global cluster with zone sharding) | earlier run, not on this build |
| 6 | "Globex needs just-in-time provisioning: new users get an account on their first SAML login." then a second person: "Agreed, let's do that." | Chat: locking in, say "wait" to stop it. Ten seconds later it is locked as the next R key (R-17 today) in Atlas | earlier run, not on this build |
| 7 | "Hey Gomon, create the tickets." | Files the GitHub issue for what was just locked and puts the link in the chat | earlier run, not on this build |
| 8 | "Hey Gomon, what's in our Atlas database right now?" | Counts from Atlas: calls, utterances, memories, call items, actions, audit events, artifacts | answer, today |
| 9 | Ask anything long, then say "stop" over it | Audio stops at once. Five words over it, or one second of talking, also stop it | unit tests, not in a Meet from this machine |
| 10 | "Hey Gomon, what's the weather in Paris?" | "I don't have anything on that yet." It does not make things up | answer, today |

**What "checked" means.** "answer, today": the question was run against the real records with `npm run ask` (same search,
prompt and model as the live path, nothing spoken or written) and the answer was right. Rows 5 to 7 use the action lane, which
`npm run ask` does not run; they passed in the scripted local meeting earlier on Nov 14, before the instruction set changed.
Nothing here was heard in a real Meet from Max's machine (it has no Recall key). Run the list once before the audience sees it.

**In the Meet chat after each answer** (turn off with `CHAT_TRACE=off`):

    Gomon · how I answered (2.2 s): Atlas memory search: 6 hits (D-09, R-14, K-01, D-06, +2) in 0.5 s · past meetings and ADRs: 9 hits in 0.3 s · read 71 team records, 8 open GitHub issues · Sonnet 5.5 wrote the answer in 1.6 s

**If something looks stuck:** the camera tile says what Gomon is doing (listening, thinking with dots and a timer, speaking,
locking). Past 4.5 s it says "Still working on that, one moment." If the answer fails it says so and asks you to repeat.
A question that was cut off mid-sentence is held for up to 3 s of quiet and joined with what you say next.

**Try a question without a meeting:** `cd apps/worker && npm run ask -- "Hey Gomon, can you look at D09?"`
