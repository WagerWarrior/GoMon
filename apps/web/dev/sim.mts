/**
 * DEV ONLY. Streams a labeled SYNTHETIC conversation into Atlas so the live workspace can be developed and shown
 * without the voice pipeline. It writes ONLY what Tamir's worker and Rob's agent will write in real life
 * (utterances, call_items, conflicts, timings); it does not touch memories/actions, which go through governance.
 * Not for the live demo: AGENTS.md forbids faking transcripts there.
 */
import { MongoClient } from "mongodb";
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
const dbName = process.env.MONGODB_DB || "gomon_dev";
if (dbName === "gomon" && !process.env.FORCE_SEED) { console.error("Refusing to simulate into 'gomon'."); process.exit(1); }
const callId = process.env.CALL_ID || "call-demo-1";
const c = new MongoClient(uri); await c.connect(); const d = c.db(dbName);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const syn = { synthetic: true };
await d.collection("utterances").deleteMany({ callId, synthetic: true }); await d.collection("call_items").deleteMany({ callId, synthetic: true });
await d.collection("conflicts").deleteMany({ callId, synthetic: true }); await d.collection("timings").deleteMany({ callId, synthetic: true });
let seq = 0;
async function say(name: string, text: string) {
  const r = await d.collection("utterances").insertOne({ callId, seq: ++seq, speaker: { displayName: name }, text, source: "sim", startedAt: new Date(), endedAt: new Date(), ...syn });
  await d.collection("timings").insertOne({ callId, stage: "utterance_to_item", ms: 900 + Math.round(Math.random() * 700), at: new Date(), ...syn });
  return r.insertedId;
}
const item = async (kind: string, text: string, status: string, u: any, extra: any = {}) => (await d.collection("call_items").insertOne({ callId, kind, text, status, sourceUtteranceIds: [u], expiresAt: new Date(Date.now() + 3600e3), ...extra, ...syn })).insertedId;
const mk = async (key: string) => d.collection("memories").findOne({ key, status: "active" });

let u = await say("Marcus", "Let's just do a flat 100 requests per second per tenant.");
const flat = await item("decision", "Flat 100 requests per second per tenant", "proposed", u);
await sleep(1200); const r12 = await mk("R-12");
await d.collection("conflicts").insertOne({ callId, itemId: flat, memoryId: r12?._id, memoryKey: "R-12", severity: "high", spoken: true, note: "Acme bursts to 2,000 req/s for 60 s", createdAt: new Date(), ...syn });
u = await say("Gomon", "That conflicts with R-12: Acme bursts to 2,000 per second for 60 seconds."); await sleep(2200);
u = await say("Lena", "We could log every request into the billing Postgres.");
const bill = await item("alternative", "Log every request into the billing Postgres", "proposed", u);
await sleep(1200); const d09 = await mk("D-09");
await d.collection("conflicts").insertOne({ callId, itemId: bill, memoryId: d09?._id, memoryKey: "D-09", severity: "high", spoken: true, note: "No synchronous per-request billing writes", createdAt: new Date(), ...syn });
await say("Gomon", "D-09 says no synchronous per-request billing writes. Earlier we chose async usage events."); await sleep(2200);
u = await say("Priya", "So token bucket in Redis at the gateway, tiered limits, enterprise burst 2,000 for 60 seconds, async usage events aggregated hourly.");
await say("Marcus", "Agreed, sounds good."); await sleep(1500);
const lock = await item("decision", "Tiered token-bucket limits in Redis at the gateway with enterprise burst 2,000 req/s for 60 s; async usage events aggregated hourly", "locking", u, { lockAnnouncedAt: new Date(), vetoMs: 10000 });
await say("Gomon", "Locking in: tiered token-bucket limits with enterprise burst."); await d.collection("call_items").updateOne({ _id: flat }, { $set: { status: "rejected" } });
console.log(`Simulated conversation written for ${callId}. Open the workspace and press Lock on the 'locking' item (10 s veto window), or Reject to veto.`);
await c.close();
