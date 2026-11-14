/** Max (workspace): create the Atlas vector index on memories and embed active memories with Voyage. Idempotent. */
import { MongoClient } from "mongodb";
import { embedMissing, ensureVectorIndex } from "../lib/retrieval";
try { process.loadEnvFile("../../.env"); } catch {}
try { process.loadEnvFile("../../.env.example"); } catch {}
const c = new MongoClient(process.env.MONGODB_URI!); await c.connect();
const d = c.db(process.env.MONGODB_DB || "gomon_max");
const sc = { teamId: process.env.TEAM_ID || "northwind-platform", projectId: process.env.PROJECT_ID || "public-api-launch" };
console.log("index:", await ensureVectorIndex(d));
console.log("embedded:", await embedMissing(d, sc));
for (let i = 0; i < 60; i++) {
  const [ix] = await d.collection("memories").listSearchIndexes("memories_vector").toArray();
  if ((ix as any)?.queryable) { console.log("index queryable"); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
await c.close();
