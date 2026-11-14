# Northwind Platform — standing engineering policies (SYNTHETIC)

Fictional policies used for the Gomon demo. Not real data. They apply to every project.

- **D-09** (decision): No synchronous per-request writes to the billing database; usage leaves the request path as asynchronous usage events.
- **C-01** (constraint): Every schema change ships as a reviewed migration (pull request labeled migration, approved by the data owner); nobody edits production schemas or indexes by hand in the Atlas UI.
- **C-02** (constraint): Every Sev1 incident gets a written postmortem within five business days, with its action items tracked as GitHub issues.
- **C-04** (constraint): No customer PII or raw API keys in logs; API keys are stored only as salted hashes.
- **C-05** (constraint): A new public endpoint needs a reviewed OpenAPI spec before implementation starts.
