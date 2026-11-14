# Northwind Platform — customers and contracts (SYNTHETIC)

Fictional customers used for the Gomon demo. Not real data. Company-wide context: readable from every project.

## Acme Corp (launch customer, $1.2M ARR, logistics)

- **R-12** (requirement): Acme's nightly batch sync (02:00 UTC) bursts to 3,000 requests per second for 60 seconds; the public API must absorb that burst for Acme's tenant without returning 429s.
- **R-14** (requirement): Acme must see its remaining quota in a response header on every API call so its sync client can pace itself.

## Globex (enterprise, $800k ARR, renewal in March 2027)

- **R-01** (requirement): Globex requires SSO via SAML 2.0 and user provisioning via SCIM 2.0 in production by the end of Q1 2027 as a condition of its renewal.
- **R-02** (requirement): Globex requires EU data residency: all Globex tenant data, including backups and usage events, must be stored and processed in the EU.
- **K-01** (risk): Globex EU residency (R-02) conflicts with today's single-region us-east-1 production setup (D-07); meeting it needs an EU footprint we do not run yet.

## Initech (enterprise, $650k ARR, financial services)

- **R-03** (requirement): Initech's contract guarantees 99.95% monthly availability of the public API, with service credits for every 0.05% below.
- **R-04** (requirement): Initech requires a daily export of all admin and audit events for its tenant to its own S3 bucket within 24 hours, retained for one year.

## Umbrella Health (prospect, ~$400k ARR, decision expected December 2026)

- **A-02** (assumption): Umbrella Health will only sign if we sign a HIPAA Business Associate Agreement; no PHI is stored today, so this is a new compliance scope.
- **Q-01** (open_question): Do we sign a HIPAA BAA for Umbrella Health this year, or decline until the audit-export and residency work is done?
