# apps/connectors: GitHub + Slack outbox worker (Max)

Only this code touches GitHub or Slack. The agent and the workspace write `actions`; this worker consumes them.

```bash
cd apps/connectors && npm install
GITHUB_TOKEN=... GITHUB_REPO=WagerWarrior/MongoDB SLACK_BOT_TOKEN=... SLACK_CHANNEL_ID=... npm start
npm test    # fake GitHub/Slack servers + a real MongoDB replica set; no network, nothing real is sent
```

Per action: **atomic claim** (`queued -> sending`) -> **policy check** (default-deny; result stored in `policyCheck`) -> **send** ->
one update sets `status: sent` **and** `externalId` together (a request is not "created" until the external ID is stored) -> best-effort
read-back upgrades GitHub issues to `confirmed`. Denied actions send nothing and are audited.

**No duplicates:** GitHub issues carry `<!-- gomon-idempotency:KEY -->`; Slack messages carry `metadata.event_payload.idempotencyKey`.
Any retry (or a claim stuck in `sending` after a crash) first looks for the earlier attempt's side effect and adopts it.
Slack uses one thread per call (`calls.slackThreadTs`, root created once). 5xx/timeouts back off (max 5 attempts); 401/403/404/422,
`channel_not_found`, missing tokens fail immediately with the reason. An unknown assignee files the issue unassigned and records why.

Wakes on a change stream (resume token in `stream_offsets`) and also sweeps every 2 s, so a missed event or a restart never strands an action.

**Not verified against the real services:** tests use local fakes. A real send needs `GITHUB_TOKEN`/`SLACK_BOT_TOKEN` and has not been run.
The Slack bot needs `chat:write` (and `channels:history`/`groups:history` for the retry lookup).
