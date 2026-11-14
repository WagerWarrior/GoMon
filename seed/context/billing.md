# Northwind API — billing and metering (SYNTHETIC)

Fictional company used for the Gomon demo. Not real data.

- **D-09** (decision): No synchronous per-request writes to the billing database; usage leaves the request path as asynchronous usage events.
- **R-15** (requirement): Usage must be billed per tenant, monthly, and be auditable down to the hour.
- **K-04** (risk): The billing Postgres primary saturated at 3,000 writes/s during the 2025 load test; anything that writes per request will take it down.
