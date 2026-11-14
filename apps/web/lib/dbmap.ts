/** How the Gomon collections group, and which part of the system reads or writes each one. Shared by the sidebar and /database. */
export const DB_GROUPS: { group: string; colls: string[] }[] = [
  { group: "Memory", colls: ["memories", "call_items", "conflicts", "counters"] },
  { group: "Sessions", colls: ["calls", "utterances", "says", "agent_events", "timings"] },
  { group: "Outbox", colls: ["actions", "workflows", "workflow_runs", "audit_events"] },
  { group: "Team", colls: ["members", "policies", "agent_templates", "teams", "projects"] },
];
export const USED_BY: Record<string, { writes: string[]; reads: string[]; note: string }> = {
  memories: { writes: ["governance lock", "correct / forget"], reads: ["memory search (vector + text)", "Ask Gomon", "workflows"], note: "Canonical team memory. Versioned; old versions are superseded, never deleted." },
  call_items: { writes: ["reasoning (append)"], reads: ["governance", "workspace"], note: "Per-call scratch: what was proposed. Expires after the TTL unless locked." },
  conflicts: { writes: ["reasoning (flag)"], reads: ["workspace", "Gomon says"], note: "A proposal that clashes with locked memory." },
  counters: { writes: ["lock"], reads: ["lock"], note: "Next memory key per kind (D-14, R-15)." },
  calls: { writes: ["worker (ensure call)", "template picker"], reads: ["every page"], note: "One row per meeting." },
  utterances: { writes: ["Recall bot", "typed / Mission control"], reads: ["worker change stream", "transcript"], note: "Everything heard. Inserts wake the worker." },
  says: { writes: ["reasoning (speak)", "Say in call"], reads: ["bot page (voice out)"], note: "What Gomon says out loud." },
  agent_events: { writes: ["worker"], reads: ["tool calls", "context"], note: "One row per agent run: batch, wake, recalled memories." },
  timings: { writes: ["worker"], reads: ["latency charts", "benchmarks"], note: "Stage timings: queue, retrieve, analyze, total." },
  actions: { writes: ["lock buttons", "voice commands", "workflows"], reads: ["connectors outbox"], note: "Outbox: Slack posts and GitHub issues, policy checked and idempotent." },
  workflows: { writes: ["Workflows page"], reads: ["connectors"], note: "Stored triggers: when X happens, run these steps." },
  workflow_runs: { writes: ["connectors"], reads: ["Workflows page", "session events"], note: "One row per workflow firing." },
  audit_events: { writes: ["every governed change"], reads: ["activity", "workflows trigger"], note: "Who did what, when, and why." },
  members: { writes: ["seed"], reads: ["policy checks", "guest detection"], note: "Team members and roles." },
  policies: { writes: ["seed"], reads: ["governance", "outbox"], note: "Which roles may do which action." },
  agent_templates: { writes: ["templates API (leads)"], reads: ["worker every batch"], note: "How Gomon behaves on a call." },
  teams: { writes: ["seed"], reads: ["sidebar"], note: "" }, projects: { writes: ["seed"], reads: ["scope"], note: "" },
};
