import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { config } from "./config.ts";
import type { AgentTemplate, AuditEvent, CallItem, Conflict, Memory, Say, Utterance } from "./shapes.ts";

let client: MongoClient | undefined;

export async function connect(): Promise<{ client: MongoClient; db: Db }> {
  if (!client) {
    client = new MongoClient(config.mongoUri(), { appName: "gomon-worker", maxPoolSize: 20 });
    await client.connect();
  }
  return { client, db: client.db(config.dbName) };
}

export async function close(): Promise<void> {
  await client?.close();
  client = undefined;
}

/** Every collection the worker touches. Names match apps/web and apps/connectors. */
export interface Cols {
  teams: Collection<Document>;
  projects: Collection<Document>;
  members: Collection<Document>;
  policies: Collection<Document>;
  calls: Collection<Document>;
  utterances: Collection<Utterance>;
  callItems: Collection<CallItem>;
  memories: Collection<Memory>;
  conflicts: Collection<Conflict>;
  actions: Collection<Document>;
  auditEvents: Collection<AuditEvent>;
  agentEvents: Collection<Document>;
  timings: Collection<Document>;
  says: Collection<Say>;
  counters: Collection<{ _id: string; n: number }>;
  streamOffsets: Collection<{ _id: string; token: unknown; at: Date }>;
  agentTemplates: Collection<AgentTemplate>;
  chatMessages: Collection<Document>;
  users: Collection<Document>;
  userSessions: Collection<Document>;
  /** Design artifacts (ADRs) written when decisions lock; `text` is embedded by Atlas (artifacts_auto, Voyage). */
  artifacts: Collection<Document>;
}

export function cols(db: Db): Cols {
  return {
    teams: db.collection("teams"),
    projects: db.collection("projects"),
    members: db.collection("members"),
    policies: db.collection("policies"),
    calls: db.collection("calls"),
    utterances: db.collection<Utterance>("utterances"),
    callItems: db.collection<CallItem>("call_items"),
    memories: db.collection<Memory>("memories"),
    conflicts: db.collection<Conflict>("conflicts"),
    actions: db.collection("actions"),
    auditEvents: db.collection<AuditEvent>("audit_events"),
    agentEvents: db.collection("agent_events"),
    timings: db.collection("timings"),
    says: db.collection<Say>("says"),
    counters: db.collection<{ _id: string; n: number }>("counters"),
    streamOffsets: db.collection<{ _id: string; token: unknown; at: Date }>("stream_offsets"),
    agentTemplates: db.collection<AgentTemplate>("agent_templates"),
    chatMessages: db.collection("chat_messages"),
    users: db.collection("users"),
    userSessions: db.collection("user_sessions"),
    artifacts: db.collection("artifacts"),
  };
}
