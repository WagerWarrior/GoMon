# Max lane: workspace + connectors (status)

Owner: Max. Covers `apps/web` (live workspace, governance) and `apps/connectors` (outbox worker).

## Verified end to end
- 22 tests pass (`apps/web`: 11, `apps/connectors`: 11).
- Real send: UI "Create tickets" -> `actions` outbox -> connector worker -> GitHub issue
  https://github.com/WagerWarrior/MongoDB/issues/2 (`externalId` stored, status `confirmed`,
  policy result recorded in `audit_events`). Repeat clicks return `duplicate: true` (idempotency key).
- Not verified: Slack send (no `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` yet), Atlas (the Atlas Admin
  keys in `.env.example` return 401 from this machine; likely an API access list entry is needed).
  Local single-node replica set `rs0` is used instead (change streams + transactions like Atlas).

## Handoffs
- Rob: `apps/web/README.md` lists the collection shapes the workspace assumes; reconcile with the
  Atlas schema / `packages/shared`.
- Tamir: workspace reads `utterances` live via change streams; any writer works.
