# Northwind API — platform architecture (SYNTHETIC)

Fictional company used for the Gomon demo. Not real data.

- **D-07** (decision): Single region us-east-1 for all public API traffic; a Redis cluster already runs next to the Envoy gateway and is the place for per-request counters.
- **D-11** (decision): Envoy is the only public ingress; every public endpoint is versioned under /v1 and authenticated with per-tenant API keys.
- **C-03** (constraint): The gateway adds at most 5 ms p99 latency; no synchronous calls to services outside the gateway's availability zone on the request path.
