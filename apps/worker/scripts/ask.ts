/**
 * Ask Gomon a question against the real records without speaking or writing anything (read-only): the same context, prompt
 * and grounding as the fast lane.
 *   npm run ask -- "<question>" [callId]        (callId defaults to the latest call)
 *   npm run ask -- --suite [callId]             the demo's questions (Nov 14) in one go
 *   npm run ask -- --demo [callId]              the Meridian fraud demo script, in order (read-only: nothing is filed)
 */
import { ObjectId } from "mongodb";
import { connect, cols, close } from "../src/db.ts";
import { config } from "../src/config.ts";
import { fastReply } from "../src/fast.ts";
import { spokenKeys } from "../src/hold.ts";

const [q, cid] = process.argv.slice(2);
const SUITE = [
  "Hey Gomon, can you summarize D17 for me?",
  "Hey Gomon, can you check ticket D15 and tell me what it is?",
  "Hey Gomon, can you look at D09?",
  "Hey Gomon, who are the participants in this call?",
  "Hey Gomon, what meeting are we in right now?",
  "Hey Gomon, do you have any outstanding tickets right now?",
  "Hey Gomon, what GitHub issues have you filed?",
  "Hey Gomon, what did we discuss in previous meetings?",
  "Hey Gomon, who owns the billing pipeline?",
  "Hey Gomon, what's the latest decision we made?",
  "Hey Gomon, what's the weather in Paris?",
  "Hey Gomon, which issues are open and who has them?",
  "Hey Gomon, what constraints do we have for adding an EU cluster?",
  "Hey Gomon, what's in our Atlas database right now?",
  "Hey Gomon, what ADRs do we have on data residency?",
  "Hey Gomon, how do you find things in memory?",
];
// The fraud demo (Nov 14, second run): what happened, which tickets are open, what K-05 is (as speech-to-text spells it).
const DEMO = [
  "Hey Gomez, what happened with the Meridian fraud case?",
  "Hey Gomon, which fraud tickets don't have anyone assigned?",
  "Hey Gomon, what's ticket KL5?",
  "Hey Gomon, who should we assign K-05 to?",
  "Hey Gomon, when does the fraud case have to be resolved?",
];
const { client, db } = await connect(); const c = cols(db);
const call = cid ? await c.calls.findOne({ _id: cid as never }) : await c.calls.find({ teamId: config.teamId }).sort({ startedAt: -1 }).limit(1).next();
if (!call) throw new Error("no call");
const ctx = { client, c, teamId: config.teamId, projectId: String(call.projectId ?? config.projectId) };
console.log(`call ${call._id} "${call.title}" (${ctx.projectId}), model ${config.analyzeModel}\n`);
for (const text of q === "--demo" ? DEMO : q === "--suite" || !q ? SUITE : [q]) {
  const t0 = Date.now();
  const a = await fastReply(ctx, { _id: new ObjectId(), callId: String(call._id), seq: Number(call.utteranceSeq ?? 0) + 1, text: spokenKeys(text), speaker: { displayName: "Max Naidenov" } }, true);
  console.log(`Q: ${text}\nA: ${a}   (${Date.now() - t0} ms)\n`);
}
await close();
