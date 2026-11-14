# MongoDbHackathon

## Project boundary
- This is a standalone hackathon project: https://github.com/WagerWarrior/MongoDB.
- Work only inside this repository. Do not import sibling projects' instructions, code, branding, customer data, credentials, infrastructure, or deployment assumptions.
- Use the Hackathon 11/14 Slack workspace for project context, not unrelated workspaces.
- Keep delegated agents and their artifacts scoped to this repository. Give each agent an explicit file boundary and acceptance criterion.

## Current scope
- Read `spec.md` before implementation. It separates the Slack proposal from implementation recommendations.
- Start with one fictional flight: stale airport display, supervisor approval, refresh, fresh verification.
- Build a turn-based classifier/driver loop: classify before every driver call and after every tool result. Supported answers bypass further driver reasoning.
- Use LangChain/LangGraph for orchestration, MongoDB for operational state and learning records, LangSmith for traces/evals, and ElevenLabs for committed speech input and approved speech output.
- Self-learning means offline supervised classifier training with calibrated thresholds and evaluated, versioned promotion. LangSmith is not an automatic training or deployment service.
- Keep an always-driver baseline; measure actual end-to-end latency and driver calls. Do not claim that hidden in-flight model reasoning can be interrupted by the router.
- Process committed transcripts only; deduplicate turn events, serialize incident work, and revalidate evidence revisions before responding or acting.
- Transport recovery and refresh acknowledgment are not proof of display recovery.
- Enforce approval and closure rules on the server, never only in the prompt or browser.
- Memory may reorder investigation checks; it cannot grant permission or replace current observations.
- Keep model responses, voice, and UI consistent with persisted incident evidence.

## Delivery
- Ship the smallest end-to-end slice before adding orchestration complexity.
- Keep secrets in local environment configuration; never commit them or borrow credentials from other projects.
- Simulated operational data must be labeled. Do not fake model responses, retrieval, checkpoints, benchmark results, or recovery receipts.
- Record actual tool order and command effects so the memory and restart demos can be verified.
- Split training/eval data by incident and scenario family. Never train on held-out test cases or accept model-generated labels without review/oracle evidence.
- Keep classifier artifacts, calibration, dataset versions, and LangSmith experiment IDs reproducible; a candidate must pass safety/correctness gates before promotion.
- Do not claim aviation safety, exactly-once external effects, or benchmark superiority without supporting evidence.
