// Check every credential in the repo-root .env against its provider, without printing any value.
// Usage: npm run check-keys   (from apps/bot-page)
// Use it after rotating keys: every line should say OK before a demo.
import { createRequire } from "node:module";

const env = process.env;
const results = [];
const add = (name, state, note = "") => results.push({ name, state, note });

async function http(name, key, url, init, ok = (r) => r.ok) {
  if (!key) return add(name, "not set");
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    if (ok(r, json)) return add(name, "OK");
    const why = json?.error?.message || json?.error || json?.detail?.message || json?.detail?.status || `HTTP ${r.status}`;
    add(name, "DEAD", String(typeof why === "string" ? why : JSON.stringify(why)).slice(0, 80));
  } catch (e) {
    add(name, "UNREACHABLE", e.message.slice(0, 80));
  }
}

await Promise.all([
  http("LLM_API_KEY (Claude)", env.LLM_API_KEY, "https://api.anthropic.com/v1/models?limit=1",
    { headers: { "x-api-key": env.LLM_API_KEY ?? "", "anthropic-version": "2023-06-01" } }),
  http("ELEVENLABS_API_KEY", env.ELEVENLABS_API_KEY, "https://api.elevenlabs.io/v1/voices",
    { headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "" } }),
  http("RECALL_API_KEY", env.RECALL_API_KEY, `https://${env.RECALL_REGION || "us-west-2"}.recall.ai/api/v1/bot/?page_size=1`,
    { headers: { authorization: `Token ${env.RECALL_API_KEY ?? ""}` } }),
  http("SLACK_BOT_TOKEN", env.SLACK_BOT_TOKEN, "https://slack.com/api/auth.test",
    { method: "POST", headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN ?? ""}` } }, (r, j) => r.ok && j?.ok === true),
  http("GITHUB_TOKEN", env.GITHUB_TOKEN, "https://api.github.com/user",
    { headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`, "user-agent": "gomon-check-keys" } }),
  http("LANGSMITH_API_KEY", env.LANGSMITH_API_KEY, "https://api.smith.langchain.com/api/v1/sessions?limit=1",
    { headers: { "x-api-key": env.LANGSMITH_API_KEY ?? "" } }),
  http("VOYAGE_API_KEY", env.VOYAGE_API_KEY, "https://api.voyageai.com/v1/embeddings",
    { method: "POST", headers: { authorization: `Bearer ${env.VOYAGE_API_KEY ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ input: ["ping"], model: env.VOYAGE_MODEL || "voyage-4" }) }),
]);

// MongoDB needs the driver, which lives in apps/worker (bot-page itself has no dependencies).
if (!env.MONGODB_URI) add("MONGODB_URI", "not set");
else {
  try {
    const { MongoClient } = createRequire(new URL("../../worker/package.json", import.meta.url))("mongodb");
    const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8_000 });
    await client.connect();
    await client.db(env.MONGODB_DB || "gomon").command({ ping: 1 });
    await client.close();
    add("MONGODB_URI", "OK");
  } catch (e) {
    add("MONGODB_URI", e.code === "MODULE_NOT_FOUND" ? "not checked" : "DEAD",
      e.code === "MODULE_NOT_FOUND" ? "run `npm install` in apps/worker first" : e.message.slice(0, 80));
  }
}

const order = ["LLM_API_KEY (Claude)", "MONGODB_URI", "ELEVENLABS_API_KEY", "RECALL_API_KEY", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "VOYAGE_API_KEY", "LANGSMITH_API_KEY"];
results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
for (const r of results) console.log(`${r.state.padEnd(11)} ${r.name}${r.note ? `  (${r.note})` : ""}`);
const dead = results.filter((r) => r.state === "DEAD" || r.state === "UNREACHABLE");
console.log(dead.length ? `\n${dead.length} credential(s) need replacing: ${dead.map((r) => r.name).join(", ")}` : "\nEvery credential that is set works.");
process.exit(dead.length ? 1 : 0);
