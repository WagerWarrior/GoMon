# Max lane: workspace + connectors (status)

Owner: Max. Covers `apps/web` (live workspace, governance) and `apps/connectors` (outbox worker).

## Verified end to end
- 22 tests pass (`apps/web`: 11, `apps/connectors`: 11).
- Real send: UI "Create tickets" -> `actions` outbox -> connector worker -> GitHub issue
  https://github.com/WagerWarrior/MongoDB/issues/2 (`externalId` stored, status `confirmed`,
  policy result recorded in `audit_events`). Repeat clicks return `duplicate: true` (idempotency key).
- Atlas verified (cluster0, db `gomon_max`, so Rob's `gomon` is untouched): seed + sim, lock via transaction,
  change stream -> outbox -> GitHub issues #4 and #5, both `confirmed`. Run with
  `MONGODB_URI=... MONGODB_DB=gomon_max` for `apps/web`, `apps/connectors` and `dev/seed.mts`.
- Not verified: Slack send (no `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` yet). The Atlas Admin API keys still return 401;
  the `MONGODB_URI` connection works, so this does not block anything.

## Handoffs
- Rob: `apps/web/README.md` lists the collection shapes the workspace assumes; reconcile with the
  Atlas schema / `packages/shared`.
- Tamir: workspace reads `utterances` live via change streams; any writer works.
