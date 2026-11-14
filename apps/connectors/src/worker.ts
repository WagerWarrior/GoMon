import type { Db } from "mongodb";
import { dueActionIds, processAction } from "./outbox";
import type { Env } from "./types";

/**
 * Consumes the outbox. A change stream wakes it immediately; a periodic sweep also runs so a missed event, a retry
 * that came due, or a restart never strands an action. The resume token is persisted in stream_offsets.
 */
export function runConnectors(d: Db, env: Env, opts: { sweepMs?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m) => console.log(`[connectors] ${m}`));
  let stopped = false; let busy = false; let again = false;
  async function sweep() {
    if (busy) { again = true; return; }
    busy = true;
    try { do { again = false; for (const id of await dueActionIds(d)) { const o = await processAction(d, id, env); if (o !== "skipped") log(`${id} -> ${o}`); } } while (again && !stopped); }
    catch (e: any) { log(`sweep error: ${e?.message ?? e}`); } finally { busy = false; }
  }
  void sweep();
  const iv = setInterval(sweep, opts.sweepMs ?? 2000);
  let cs: any;
  (async () => {
    try {
      const offsets = d.collection<any>("stream_offsets");
      const saved = await offsets.findOne({ _id: "connectors" });
      cs = d.collection("actions").watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], saved?.token ? { resumeAfter: saved.token } : {});
      cs.on("change", async (ev: any) => { await offsets.updateOne({ _id: "connectors" }, { $set: { token: ev._id, at: new Date() } }, { upsert: true }); void sweep(); });
      cs.on("error", (e: any) => log(`change stream error (sweep keeps running): ${e?.message ?? e}`));
    } catch (e: any) { log(`change stream unavailable, polling only: ${e?.message ?? e}`); }
  })();
  return { stop: async () => { stopped = true; clearInterval(iv); try { await cs?.close(); } catch {} }, sweep };
}
