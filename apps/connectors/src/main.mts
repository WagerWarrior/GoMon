import { MongoClient } from "mongodb";
import { runConnectors } from "./worker";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
const dbName = process.env.MONGODB_DB || "gomon";
const c = new MongoClient(uri); await c.connect();
const have = (k: string) => (process.env[k] ? "set" : "MISSING");
console.log(`[connectors] db=${dbName} github=${have("GITHUB_TOKEN")}/${process.env.GITHUB_REPO ?? "no repo"} slack=${have("SLACK_BOT_TOKEN")}/${process.env.SLACK_CHANNEL_ID ?? "no channel"}`);
const w = runConnectors(c.db(dbName), process.env as any);
process.on("SIGINT", async () => { await w.stop(); await c.close(); process.exit(0); });
