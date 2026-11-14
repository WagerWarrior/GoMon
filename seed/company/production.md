# Northwind Platform — production system and data architecture (SYNTHETIC)

Fictional system used for the Gomon demo. Not real data.

- **D-01** (decision): Production data lives on one MongoDB Atlas M50 replica set (nw-prod-use1, AWS us-east-1, three nodes across availability zones) with continuous cloud backup and 7-day point-in-time restore.
- **D-02** (decision): Billing reads usage through an Atlas change stream on the usage_hourly collection; the billing service is the only writer of the billing Postgres database.
- **D-03** (decision): The gateway publishes one usage event per request to the Kafka topic usage.events; the metering consumer aggregates them into hourly per-tenant rollups in Atlas (usage_hourly).
- **D-11** (decision): Envoy is the only public ingress; every public endpoint is versioned under /v1 and authenticated with per-tenant API keys.
- **C-03** (constraint): The gateway adds at most 5 ms p99 latency; no synchronous calls to services outside the gateway's availability zone on the request path.
- **K-02** (risk): The Atlas oplog window drops to about 26 hours at peak write load; a change stream consumer that falls further behind than that loses its resume token and needs a full resync.
