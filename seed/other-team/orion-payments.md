# Orion Payments team (SYNTHETIC, different team)

Seeded under a different teamId to prove memory isolation: Northwind retrieval must never return these.

- **D-01** (decision): Rate limits are a flat 100 requests per second per tenant with no burst.
- **R-03** (requirement): Payment webhooks must be retried for 72 hours.
