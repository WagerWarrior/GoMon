# Enterprise SSO — Globex-driven SAML and SCIM (SYNTHETIC)

Fictional project docs used for the Gomon demo. Not real data. Target: Globex live on SSO by March 31, 2027 (R-01).

- **R-05** (requirement): Support SP- and IdP-initiated SAML 2.0 login with Okta and Microsoft Entra ID; Globex uses Okta.
- **R-06** (requirement): SCIM 2.0 deprovisioning must disable a user's dashboard access within 5 minutes of removal in the customer's IdP.
- **A-03** (assumption): Globex rolls out to about 4,000 seats in one wave after a two-week pilot with 50 users.
- **K-03** (risk): Lena is the only engineer with identity experience; the Q1 deadline slips if she is pulled into on-call or incidents.
- **Q-03** (open_question): Can EU residency (R-02) be met with a separate Atlas cluster in eu-central-1 for EU tenants, or do we need a global cluster with zone sharding?
