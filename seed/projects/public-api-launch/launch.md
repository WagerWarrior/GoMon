# Public API launch — architecture, metering and launch plan (SYNTHETIC)

Fictional project docs used for the Gomon demo. Not real data. The public API launches on December 5, 2026; Acme is the launch customer.

- **D-07** (decision): Single region us-east-1 for all public API traffic; a Redis cluster already runs next to the Envoy gateway and is the place for per-request counters.
- **D-08** (decision): The hourly rollups in usage_hourly are the billing source of truth; raw usage events in Kafka are kept for 7 days for replay only.
- **D-10** (decision): Tiers: standard tenants get 500 requests per second sustained, enterprise tenants 1,000 requests per second sustained; per-tenant overrides live in the tenant config, not in code.
- **R-15** (requirement): Usage must be billed per tenant, monthly, and be auditable down to the hour.
- **K-04** (risk): The billing Postgres primary saturated at 3,000 writes/s during the 2025 load test; anything that writes per request will take it down.
- **A-01** (assumption): Launch traffic is at most 10x current internal API traffic in the first month.
- **Q-02** (open_question): Should rate-limit overrides be self-serve in the dashboard at launch, or set by support only?
