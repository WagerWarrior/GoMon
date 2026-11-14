import { MongoClient, type Db } from "mongodb";

/** One client per process. MONGODB_URI/MONGODB_DB come from .env (see root .env.example). */
const g = globalThis as unknown as { __gomonClient?: MongoClient };
// Local secrets live in the repo-root .env (git-ignored). Real env vars win; a missing file is fine.
try { process.loadEnvFile(`${process.cwd()}/../../.env`); } catch {}

export function uri() { return process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true"; }
export function dbName() { return process.env.MONGODB_DB || "gomon"; }
export function scope() { return { teamId: process.env.TEAM_ID || "northwind-platform", projectId: process.env.PROJECT_ID || "public-api-launch" }; }

export async function client(): Promise<MongoClient> {
  if (!g.__gomonClient) g.__gomonClient = new MongoClient(uri(), { retryWrites: true });
  await g.__gomonClient.connect();
  return g.__gomonClient;
}
export async function db(): Promise<Db> { return (await client()).db(dbName()); }
