# MongoDbHackathon

## Project boundary
- This is a standalone hackathon project: https://github.com/WagerWarrior/MongoDB.
- Work only inside this repository. Do not import sibling projects' instructions, code, branding, customer data, credentials, infrastructure, or deployment assumptions.
- Use the Hackathon 11/14 Slack workspace for project context, not unrelated workspaces.
- Keep delegated agents and their artifacts scoped to this repository. Give each agent an explicit file boundary and acceptance criterion.

## Current scope
- Read `spec.md` before implementation. It separates the Slack proposal from implementation recommendations.
- Start with one fictional flight: stale airport display, supervisor approval, refresh, fresh verification.
- Transport recovery and refresh acknowledgment are not proof of display recovery.
- Enforce approval and closure rules on the server, never only in the prompt or browser.
- Memory may reorder investigation checks; it cannot grant permission or replace current observations.
- Keep model responses, voice, and UI consistent with persisted incident evidence.

## Delivery
- Ship the smallest end-to-end slice before adding orchestration complexity.
- Keep secrets in local environment configuration; never commit them or borrow credentials from other projects.
- Simulated operational data must be labeled. Do not fake model responses, retrieval, checkpoints, benchmark results, or recovery receipts.
- Record actual tool order and command effects so the memory and restart demos can be verified.
- Do not claim aviation safety, exactly-once external effects, or benchmark superiority without supporting evidence.
