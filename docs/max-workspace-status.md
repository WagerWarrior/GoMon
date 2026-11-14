# Max lane: workspace + connectors (status)

Owner: Max. Covers `apps/web` (live workspace, governance, Ask Gomon) and `apps/connectors` (outbox worker).

## Run it (everything real)
Secrets: copy the values you need into a repo-root `.env` (git-ignored); both apps load it.
`MONGODB_DB=gomon_max` is Max's database on the shared Atlas cluster (Rob's `gomon` is untouched).

    cd apps/web && npm run seed:dev && npm run sim && npm run embed && npm run dev
    cd apps/connectors && GITHUB_TOKEN=$(gh auth token) npm start

## Verified on real services
- Atlas (cluster0, MongoDB 9.0.7): change streams drive the live workspace; lock / correct / forget run as
  transactions with audit events.
- GitHub: outbox -> issues #2, #4, #5 in this repo, read back, status `confirmed`.
- Slack: Gomon app in Hackathon 11/14, channel #testing-gomon-atlas. One thread per call, a reply per decision,
  idempotency key in message metadata, read back, status `confirmed`. The worker joins the channel at start.
- Ask Gomon (memory on vs off): Voyage `voyage-4` embeddings + Atlas Vector Search index `memories_vector`.
  Memory on cites the corrected D-07 and R-12 for the flat-limit proposal; memory off cites nothing.
- Tests: `apps/web` 12, `apps/connectors` 12, all passing; a fresh clone of main typechecks.

## Fixed along the way
- Root `.gitignore` had a Python `lib/` rule that kept `apps/web/lib/` out of git; anchored to `/lib/`.
- Slack read methods need form encoding; read-back and retry adoption were silently failing on real Slack.
- A correction copied the old version's vector; the new text is now re-embedded.

## Not done / open
- Answers are retrieval-only (cite the top memory); `LLM_API_KEY` is empty, and Rob's agent loop owns generation.
- Atlas Admin API keys return 401 (the connection string works, so nothing is blocked).
- Rob's per-call sample database vs main-brain split is not in the repo yet; the workspace scopes by
  `teamId`/`projectId` and `MONGODB_DB`, so it can point at either once the contract lands.
