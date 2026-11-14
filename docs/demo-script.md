# Live demo script: Gomon decides Globex EU residency (synthetic Northwind data)

**Setup (once):** `npm run seed -- --reset` in `apps/worker`, worker running (`VOICE_OUT=recall npm start`), web on :3000,
connectors running. `npm run join -- <meet link> demo-1 "Globex EU residency"`, admit Gomon, open
`http://localhost:3001/ears?callId=demo-1` on the laptop in the Meet, Start, share the Meet tab with audio. Headphones.
Show `http://localhost:3000/sessions/demo-1` on screen.

**What it proves:** Gomon's memory is MongoDB Atlas. Structured memory (decisions, requirements, constraints, risks,
open questions in `memories`), unstructured transcripts (`utterances`), meeting summaries (`calls.summary`) and design
artifacts (ADRs in `artifacts`) are all embedded by **Atlas Automated Embedding (Voyage `voyage-4`)** and searched with
`$vectorSearch` (+ `$rankFusion` with Atlas Search on memories), always pre-filtered by team.

| # | Who | Say | Gomon / Atlas |
|---|---|---|---|
| 1 | Rob, Max | Small talk ("how was the demo prep") | Silent. Transcript lands in `utterances` live |
| 2 | Rob | "Hey Gomon, what did we discuss in our previous meetings about Globex?" | Recalls the Globex SSO kickoff: WorkOS (D-16), API keys revoked on deprovisioning (R-16), EU residency left open (Q-03). Source: semantic search over past transcripts + summaries |
| 3 | Rob | "Today we need to decide how Globex gets EU data residency." | Captured as an open item |
| 4 | Max | "Easiest is keeping Globex in us-east-1 and adding an EU read replica." | Interjects once: conflicts with R-02 (all Globex data, backups and usage events stay in the EU) |
| 5 | Rob | "Hey Gomon, what constraints do we have for adding an EU cluster?" | C-01 reviewed migrations, D-01 single prod cluster today, K-01 residency risk |
| 6 | Rob | "Let's run a separate Atlas cluster in eu-central-1 for EU tenants. The gateway routes by tenant region, and EU usage events and backups stay in that cluster." | Captured as a proposed decision |
| 7 | Max | "Agreed, let's do that." | Meet chat: "locking in … say wait to stop it"; 10 s later locked as D-xx in `memories`, **ADR written to `artifacts`**, GitHub issue + Slack post via the outbox |
| 8 | Rob | "Hey Gomon, create the tickets." | Files the issue (or says it's already done) |
| 9 | Rob | "Hey Gomon, drop the GitHub link for that decision in the chat." | Link in Meet chat |
| 10 | Rob | "Hey Gomon, what ADRs do we have on data residency?" | Finds the new ADR (artifact search; give the index ~1 min after the lock) |

**Show Atlas after:** dashboard Database view (memories / utterances / calls / artifacts), the four search indexes
(`memories_auto`, `utterances_auto`, `calls_auto`, `artifacts_auto`: all `autoEmbed` with `voyage-4`), the audit trail
for the lock, and the ADR document.
