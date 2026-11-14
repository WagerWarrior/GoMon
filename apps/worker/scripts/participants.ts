/**
 * Keeps each call's participant list in step with the meeting, from Recall, every 10 s. Its own process: start it next to a
 * running worker without restarting anything.   npm run participants        (Ctrl+C stops it)
 *                                                npm run participants -- --once
 */
import { connect, cols, close } from "../src/db.ts";
import { sweepParticipants } from "../src/participants.ts";

const { db } = await connect(); const c = cols(db);
const once = process.argv.includes("--once");
const seen = new Map<string, string>();
const pass = async () => {
  for (const r of await sweepParticipants(c)) {
    const line = r.names === null ? "Recall has not released a participant list yet" : `${r.names.length} in the meeting: ${r.names.join(", ") || "nobody"}${r.added ? ` (+${r.added} added to the call)` : ""}`;
    if (seen.get(r.callId) !== line || once) console.log(`[participants] ${r.callId}: ${line}`);
    seen.set(r.callId, line);
  }
};
await pass().catch((e) => console.error("[participants]", e instanceof Error ? e.message : e));
if (once) await close();
else {
  console.log("[participants] watching live calls every 10 s");
  setInterval(() => void pass().catch((e) => console.error("[participants]", e instanceof Error ? e.message : e)), 10_000);
}
