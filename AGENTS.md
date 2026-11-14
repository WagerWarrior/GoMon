# MongoDbHackathon — Gomon

## Project boundary
- Standalone hackathon project: https://github.com/WagerWarrior/MongoDB. Agents in Context Toronto, submissions due 5:00 PM Nov 14, 2026.
- Work only inside this repository. Do not import code, data, credentials, or branding from other projects. All company context is synthetic (`seed/`).
- The previous aviation project is archived at tag `archive/aviation-v1`; do not restore it.
- Give each delegated agent an explicit file boundary (`apps/web`, `apps/worker`, `apps/bot-page`, `packages/shared`, `seed`) and an acceptance criterion.

## Product rules
- Read `spec.md` first. Track: Statement Two (memory you can govern) plus audited actions.
- MongoDB Atlas (hackathon sandbox) is the source of truth for utterances, call items, memories, actions, audit, and timings. The UI and the agent read from Atlas; no parallel state store.
- Only committed transcript segments become utterances. Partial text never triggers actions.
- Call items are proposals. Canonical memory changes only through a consensus lock (announced, 10 s veto) or an explicit human action, in a transaction with its audit event.
- Every memory query and vector search filters by `teamId`, `projectId`, and `status: "active"`.
- Correct and forget supersede or tombstone with history; they must remove the old memory from retrieval immediately.
- External effects (GitHub, Slack) go only through the `actions` outbox with a policy check, requester identity, idempotency key, and recorded external ID. A request is not "created" until the external ID is stored.
- Gomon speaks when addressed or for conflicts, already-decided topics, and lock announcements; alternatives at most once every 5 minutes.

## Delivery
- Keep the shared contracts in `packages/shared` stable; change them only with the team.
- Secrets live in `.env` (never committed); `.env.example` lists every key.
- Log per-stage latency to `timings`; do not claim latency or eval numbers that were not measured.
- Do not fake transcripts, retrieval results, tickets, or Slack posts in the live demo; seeded data must be labeled synthetic.
- The repo must be public before submission.
