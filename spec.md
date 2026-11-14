# MongoDbHackathon — Aviation Recovery Agent

Status: initial idea/design proposal, not an implemented product.
Repository: https://github.com/WagerWarrior/MongoDB

## 1. The idea

A voice-enabled operations copilot that answers one concrete question:

**“The connection is back. Can I close this incident?”**

It detects a missed flight-status update, asks a supervisor to approve a refresh, and verifies what actually reached the airport display. It remembers resolved incidents so the next investigation checks the right evidence sooner.

The differentiator is not another chatbot: **an agent that distinguishes a successful request from a verified outcome, and shows its evidence.**

This is a standalone hackathon project, unrelated to other repositories or company infrastructure. All aviation data is fictional; this is not a flight-control or aviation-safety system.

## 2. What the Slack discussion settled on

Sources: Hackathon 11/14 [#agent-drop](https://app.slack.com/client/T0CHS0R8L10/C0CHU319A2V), Opheer’s 11:24 build-plan post; [#new-channel](https://app.slack.com/client/T0CHS0R8L10/C0CHLT9BM7F), the 11:20–11:25 discussion.

- Concrete scenario: airline feed says **Delayed · 10:20**, while the airport display still says **On time · 10:05**.
- Restore the connection without automatically replaying the missed update; the mismatch must remain visible.
- Read both records, explain the mismatch, request supervisor approval, refresh, then reread.
- Close only after a fresh observation confirms matching flight, status, and source version. An acknowledgment alone is insufficient.
- Persist observations, approval, refresh state, and verified outcome in MongoDB Atlas under one incident ID.
- In a fresh session for a different flight, use Vector Search to retrieve the resolved case; show the case ID and the actual check moved earlier.
- Add ElevenLabs voice and a clean side-by-side dashboard. Use LangChain and a fast, turn-based decision loop.
- Build one recovery first, cross-session memory second, worker-restart recovery third. Lean and a large agent swarm are stretch goals.

The broader enterprise-critical-events platform is the future direction, not the first build. The earlier shared “IMMUNITY” concept is background; the aviation plan is the concrete starting scope. No access to Jev or a particular model is assumed.

## 3. The smallest convincing demo

1. Open directly on two conflicting records for fictional flight HX101. Display source timestamps and versions prominently.
2. Supervisor asks by voice or text: “Can I close this incident?”
3. Agent answers: “Not yet. The airport display still shows On time from 10:05; the airline feed has Delayed from 10:20.” Its explanation links to the observed records.
4. Supervisor clicks **Approve refresh** beside the evidence. The server records the approval before issuing the command.
5. Show **Refresh acknowledged — verification pending**. Keep the incident open until a new display read matches the current source.
6. Show the verification receipt and close the incident.
7. Start HX202 in a fresh session. Retrieve HX101’s resolved case and visibly compare the recorded investigation order with and without memory.

Optional final beat, after the core demo works: terminate the worker after a refresh is sent, restart it, and show that it reloads the checkpoint and inspects the display before considering another send.

## 4. Minimal design and guardrails

### State and evidence

`Investigating → Awaiting approval → Refresh pending → Verifying → Resolved`

Unavailable, mismatched, or inconclusive evidence keeps the incident open with a reason. Rejected or expired approval prevents the write.

Each observation records `incidentId`, `flightId`, `status`, `sourceTime`, `sourceVersion`, and `observedAt`. Source time is not observation time: an old source value freshly read is still stale.

For a refresh-driven closure, obtain post-command reads of both systems. Require the same flight identity, status, source version, and associated source time. If the source advances during verification, recheck against the latest version rather than accepting the old command target. Close atomically against the evidence/version being verified; this proves consistency at that observation, not perpetual synchronization.

### Approval and restart safety

- Bind approval to the incident, flight, proposed action, and source version; record the supervisor identity. If the target changes, invalidate the approval and ask again.
- Use a stable command ID and receiver-side deduplication in the simulator. Record command intent before sending, acknowledgment separately, and verified application separately.
- On restart, load the checkpoint, inspect command status and fresh display state, and reuse the same command ID if a resend is justified. A missing acknowledgment does not prove the command failed.
- If a real receiver cannot deduplicate or expose completion, keep an ambiguous command open for review rather than claiming exactly-once behavior.
- Voice may request an investigation or explain evidence; it cannot bypass the server’s approval gate. Keep explicit approval in the UI for the first build.

### Suggested implementation, not yet a team commitment

- **UI:** React/TypeScript single-screen operations desk. Large source/display cards, an evidence timeline, one approval control, compact voice transcript, and a memory receipt. No decorative agent swarm.
- **Backend:** Python service plus LangGraph worker using LangChain tools. Separate observation, approval, command execution, and verification nodes. Deterministic code owns permission and closure; the model explains evidence and proposes the next permitted check.
- **Atlas:** operational records and incident evidence; LangGraph checkpoints; resolved-case memory with Vector Search. Start with one cluster and separate collections, not additional databases or queues.
- **Voice:** ElevenLabs browser SDK connected to backend tools. Short-lived session authorization from the server; no provider secrets in the client. Voice/text use the same incident state, not independent decision makers.
- **Model:** choose an available low-latency tool-capable model after checking team access; record the exact model/version in evaluations. Provider/model choice is open.

A stored memory contains the resolved case ID, failure pattern, useful check, evidence references, and verified outcome. Filter retrieval to resolved, compatible cases in this project. Memory is advice, not live truth or authorization. Wait for the new case to be searchable before presenting the cross-session demo; never substitute a hard-coded “retrieved” result.

LangGraph checkpoints alone do not make side effects exactly-once: resumed nodes may replay. [Official interrupt guidance](https://docs.langchain.com/oss/python/langgraph/interrupts) requires idempotent side effects. [Atlas Vector Search](https://www.mongodb.com/docs/atlas/atlas-vector-search/) provides retrieval, not a replacement for transactional operational reads.

## 5. Build order and acceptance

| Increment | Deliverable | Proof before expanding |
|---|---|---|
| 1. Recovery slice | Two-record simulator, dashboard, approval, refresh, verification, persisted incident | Reconnect leaves display stale; no approval means no write; ACK without matching display cannot close |
| 2. Voice | Ask the same incident question through ElevenLabs | Spoken answer names the stale display and timestamp and agrees with the UI; voice cannot approve a write |
| 3. Memory | Resolved-case embedding and Atlas retrieval in a fresh session | Different flight retrieves the real case ID; paired traces show the useful check earlier without weakening any gate |
| 4. Restart | Durable checkpoint and deduplicated command handling | Terminate after send; restart reads display before resend; one applied command effect in the simulator |
| 5. Evaluation | Repeatable local cases and an honest results panel | Publish pass counts, failures, exact configurations, and latency measurements; no invented scores |

Workstreams from Slack: simulator; recovery agent; Atlas/checkpoints/memory; dashboard/voice/demo. Agree record and command contracts first, then split files. Team ownership is not assigned by this document.

## 6. Benchmarks and research worth using

Keep the initial implementation small. These are research/evaluation references, not a dependency list.

| Public benchmark | Why it fits | Limit |
|---|---|---|
| [τ-bench / τ² airline](https://github.com/sierra-research/tau2-bench), [paper](https://arxiv.org/abs/2506.07982) | Stateful tool use, user interaction, policy compliance, outcome-based evaluation | Airline customer service, not display recovery or aviation safety; pin release, task set, and simulator before comparisons |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [paper](https://arxiv.org/abs/2410.10813) | Cross-session retrieval, temporal reasoning, knowledge updates, abstention | Memory QA does not prove that the agent changed its investigation order |
| [τ-Voice](https://arxiv.org/abs/2603.13686) and the τ-bench voice harness | Grounded voice/tool tasks and turn-taking evaluation | Provider setup and benchmark versions affect comparability; voice quality alone does not establish correct recovery |

Research directions: τ²’s collaboration model informs the human/agent boundary; LongMemEval’s indexing/retrieval/reading split informs memory evaluation; [MemGPT](https://arxiv.org/abs/2310.08560) provides background on separating durable memory from the active context. Borrow the concepts, not an extra memory platform.

**Our local recovery benchmark:** stale display; restored connection without replay; ACK without application; wrong-flight display; source advancing during approval/verification; denied approval; unavailable reads; lost ACK; restart after send; irrelevant or outdated retrieved case. Derive expected results from simulator state and an effects ledger, not the model’s explanation.

Report false closures/all closures (and unsafe closures/all scenarios), unauthorized write attempts and applied writes separately, duplicate applied effects/restart trials, successful verified recoveries/eligible trials, retrieval recall@k, and paired change in useful-check position. Report zero denominators as N/A. Measure voice end-of-speech to first audible answer at p50/p95, plus factual agreement with the evidence. Pair memory/no-memory runs on the same scenarios, pin model/prompts/seeds where available, and keep a held-out set. No results have been run yet.

## 7. Reuse and the “wow” effect

- [langchain-mongodb](https://github.com/langchain-ai/langchain-mongodb) — MIT; reuse its MongoDB LangGraph checkpointer rather than inventing checkpoint storage. Our incident/approval/command schema remains application logic.
- [ElevenLabs packages](https://github.com/elevenlabs/packages) — MIT; reuse the browser/React voice SDK. Browser tools must still call server-enforced endpoints.
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [τ-bench](https://github.com/sierra-research/tau2-bench) — public evaluation harnesses; adapt methodology first, run official suites separately if useful. Respect upstream data/provider requirements.

The [MongoDB NYC hackathon gallery](https://cerebralvalley.ai/e/mongodb-nyc-hackathon/hackathon/gallery.md) lists **Ripple first, Offload second, and Morgadarsha third**. Their published descriptions emphasize hidden checks, durable learning, and local outcome verification. Design takeaway: show a visible failure, the evidence-backed correction, and what improves next time. These are inspiration, not code to copy without license review.

Our three demo differentiators: **ACK is not recovery; memory changes an observed check order; restart does not blindly resend.** Show receipts for each, not animated claims of intelligence.

The Slack-requested BowUI/“Anatomy Skill” references are not verified design dependencies. Do not block the first slice on them or claim an unavailable skill was used.

## 8. Decisions to settle next

1. Confirm the aviation scenario as the first demo, using the concrete Agent Drop proposal above.
2. Choose team-accessible model, embedding provider, Atlas project, and ElevenLabs account with project-specific credentials.
3. Agree simulator/agent contracts and workstream ownership, then ship increment 1 before expanding the platform.

Non-goals for this first build: live airline integration, autonomous operational changes, formal safety certification, a general enterprise platform, and a large multi-agent swarm.
