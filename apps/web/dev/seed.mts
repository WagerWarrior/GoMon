/**
 * DEV ONLY. Labeled SYNTHETIC fixtures so the workspace can be built and demoed before the voice pipeline exists.
 * Mirrors the spec's Northwind API scenario (D-07, D-09, R-12, R-15). Never used as "live" data: every document is
 * flagged synthetic: true, and it refuses to run against a database named "gomon" unless FORCE_SEED=1.
 * Run: npm run seed:dev   (MONGODB_DB defaults to gomon_dev here)
 */
import { MongoClient } from "mongodb";
const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
const dbName = process.env.MONGODB_DB || "gomon_dev";
const TEAM = process.env.TEAM_ID || "northwind-platform", PROJECT = process.env.PROJECT_ID || "public-api-launch";
if (dbName === "gomon" && !process.env.FORCE_SEED) { console.error("Refusing to seed the shared 'gomon' database. Set FORCE_SEED=1 to override."); process.exit(1); }

const c = new MongoClient(uri); await c.connect(); const d = c.db(dbName);
for (const col of ["calls", "utterances", "call_items", "memories", "conflicts", "actions", "audit_events", "timings", "members", "policies", "teams", "projects"]) await d.collection(col).deleteMany({ synthetic: true });
await d.collection("actions").createIndex({ idempotencyKey: 1 }, { unique: true });
const syn = { synthetic: true };
await d.collection("teams").insertOne({ _id: TEAM as any, name: "Northwind Platform", ...syn });
await d.collection("projects").insertOne({ _id: PROJECT as any, teamId: TEAM, name: "Public API launch", ...syn });
await d.collection("members").insertMany([
  { teamId: TEAM, displayName: "Priya", role: "lead", ...syn }, { teamId: TEAM, displayName: "Marcus", role: "engineer", ...syn }, { teamId: TEAM, displayName: "Lena", role: "engineer", ...syn }]);
await d.collection("policies").insertMany(["lock_decision", "create_issue", "post_slack"].map((action) => ({ teamId: TEAM, projectId: PROJECT, action, allowedRoles: ["lead", "engineer"], ...syn }))
  .concat([{ teamId: TEAM, projectId: PROJECT, action: "forget_memory", allowedRoles: ["lead"], ...syn }]));
const mem = (key: string, kind: string, text: string, src: string) => ({ teamId: TEAM, projectId: PROJECT, key, kind, text, status: "active", version: 1, origin: "doc", sourceRefs: [{ type: "doc", path: src }], createdAt: new Date(Date.now() - 864e5), ...syn });
await d.collection("memories").insertMany([
  mem("D-07", "decision", "Single region us-east-1; Redis cluster already runs at the gateway.", "seed/context/architecture.md"),
  mem("D-09", "decision", "No synchronous per-request writes to the billing database.", "seed/context/billing.md"),
  mem("R-12", "requirement", "Acme needs bursts of 2,000 req/s for 60 s during nightly batch sync.", "seed/context/acme-requirements.md"),
  mem("R-15", "requirement", "Usage must be billed per tenant, monthly, and be auditable.", "seed/context/finance.md")]);
const callId = "call-demo-1";
await d.collection("calls").insertOne({ _id: callId as any, teamId: TEAM, projectId: PROJECT, title: "Rate limits and metering", status: "live", participants: ["Priya", "Marcus", "Lena"], startedAt: new Date(), ...syn });
console.log(`Seeded synthetic dev data into ${dbName}: call ${callId} with D-07, D-09, R-12, R-15. Run 'npm run sim' to stream a labeled synthetic conversation.`);
await c.close();
