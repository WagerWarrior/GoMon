import { MongoClient, ObjectId } from "mongodb";
export const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
export const TEAM = "northwind-platform", PROJECT = "public-api-launch";

/** Fresh isolated database per test file, with the indexes the spec says Atlas has. */
export async function freshDb() {
  const c = new MongoClient(URI); await c.connect();
  const name = "test_" + Math.random().toString(36).slice(2, 10);
  const d = c.db(name);
  await d.collection("actions").createIndex({ idempotencyKey: 1 }, { unique: true });
  await d.collection("members").insertMany([
    { teamId: TEAM, displayName: "Priya", role: "lead" }, { teamId: TEAM, displayName: "Marcus", role: "engineer" }, { teamId: TEAM, displayName: "Lena", role: "observer" }]);
  await d.collection("policies").insertMany([
    { teamId: TEAM, projectId: PROJECT, action: "lock_decision", allowedRoles: ["lead", "engineer"] },
    { teamId: TEAM, projectId: PROJECT, action: "forget_memory", allowedRoles: ["lead"] },
    { teamId: TEAM, projectId: PROJECT, action: "correct_memory", allowedRoles: ["lead", "engineer"] },
    { teamId: TEAM, projectId: PROJECT, action: "create_issue", allowedRoles: ["lead", "engineer"] },
    { teamId: TEAM, projectId: PROJECT, action: "post_slack", allowedRoles: ["lead", "engineer"] }]);
  const ctx = { c, d, teamId: TEAM, projectId: PROJECT };
  return { ctx, d, c, name, done: async () => { await c.db(name).dropDatabase(); await c.close(); } };
}
export async function seedCall(d: ReturnType<MongoClient["db"]>) {
  const callId = "call-1";
  await d.collection("calls").insertOne({ _id: callId as any, teamId: TEAM, projectId: PROJECT, participants: ["Priya", "Marcus"], synthetic: true });
  const item = await d.collection("call_items").insertOne({ callId, kind: "decision", text: "Tiered token-bucket limits with enterprise burst", status: "locking", expiresAt: new Date(Date.now() + 3600e3), sourceUtteranceIds: [new ObjectId()] });
  return { callId, itemId: String(item.insertedId) };
}
