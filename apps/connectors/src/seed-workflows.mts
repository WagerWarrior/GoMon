/** Max (connectors): create the default demo workflow (decision locked -> Slack thread + GitHub issue). Idempotent. */
import { MongoClient } from "mongodb";
import { ensureWorkflowIndexes, seedDefaultWorkflow } from "./workflows";
for (const f of ["../../.env", ".env"]) { try { process.loadEnvFile(f); break; } catch {} }
const c = new MongoClient(process.env.MONGODB_URI!); await c.connect();
const d = c.db(process.env.MONGODB_DB || "gomon");
await ensureWorkflowIndexes(d);
const r = await seedDefaultWorkflow(d, { teamId: process.env.TEAM_ID || "northwind-platform", projectId: process.env.PROJECT_ID || "public-api-launch" });
console.log(r.upsertedCount ? "created default workflow" : "default workflow already exists");
await c.close();
