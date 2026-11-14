import { MongoClient, type Db } from "mongodb";

/** One client per process. MONGODB_URI/MONGODB_DB come from .env (see root .env.example). */
const g = globalThis as unknown as { __gomonClient?: MongoClient };
// Local secrets live in the repo-root .env (git-ignored). Real env vars win; a missing file is fine.
try { process.loadEnvFile(`${process.cwd()}/../../.env`); } catch {}

export function uri() { return process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true"; }
export function dbName() { return process.env.MONGODB_DB || "gomon"; }
export function scope() { return { teamId: process.env.TEAM_ID || "northwind-platform", projectId: process.env.PROJECT_ID || "public-api-launch" }; }

export async function client(): Promise<MongoClient> {
  if (!g.__gomonClient) g.__gomonClient = new MongoClient(uri(), { retryWrites: true, minPoolSize: 12, maxIdleTimeMS: 0 });
  await g.__gomonClient.connect();
  return g.__gomonClient;
}
export async function db(): Promise<Db> { return (await client()).db(dbName()); }

/**
 * Shared read-model cache, stale-while-revalidate: inside ttlMs the value is fresh; up to maxStaleMs the last value is
 * returned at once while one background refresh runs. Many viewers and polls cost one Atlas trip, and no page waits after the first load.
 */
type Entry = { at: number; value?: unknown; p: Promise<unknown>; refreshing?: boolean; ttl?: number; hits?: number };
const memo = globalThis as unknown as { __memo?: Map<string, Entry> };
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, maxStaleMs = 60_000): Promise<T> {
  const m = (memo.__memo ??= new Map()); const hit = m.get(key); const age = hit ? Date.now() - hit.at : Infinity;
  if (hit) hit.hits = (hit.hits ?? 0) + 1;
  if (hit && age < ttlMs) return hit.p as Promise<T>;
  if (hit && "value" in hit && age < maxStaleMs) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      fn().then((v) => m.set(key, { at: Date.now(), value: v, p: Promise.resolve(v), ttl: ttlMs, hits: hit.hits }), () => { hit.refreshing = false; });
    }
    return Promise.resolve(hit.value as T);
  }
  const e: Entry = { at: Date.now(), p: fn(), ttl: ttlMs, hits: 0 };
  e.p.then((v) => { e.value = v; }, () => m.delete(key));
  m.set(key, e);
  return e.p as Promise<T>;
}

/** What the read cache holds right now (for the Database page and Ask Gomon): key, age, ttl, reads served. */
export function cacheStats() {
  const m = memo.__memo ?? new Map<string, Entry>(); const now = Date.now();
  return [...m.entries()].map(([key, e]) => ({ key, ageMs: now - e.at, ttlMs: e.ttl ?? 0, hits: e.hits ?? 0, ready: "value" in e, fresh: now - e.at < (e.ttl ?? 0) })).sort((a, b) => a.key.localeCompare(b.key));
}
