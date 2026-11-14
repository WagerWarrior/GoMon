// Read-only latency probe of every call the fast reply lane makes. Writes nothing.
import { connect, cols, close } from "../src/db.ts";
import { config } from "../src/config.ts";
import { retrieve } from "../src/retrieve.ts";
import { searchKnowledge } from "../src/knowledge.ts";
import { workspaceFor } from "../src/context.ts";
import { templateFor } from "../src/templates.ts";
import { ttsMp3 } from "../src/voice.ts";
const { client, db } = await connect(); const c = cols(db);
const ctx = { client, c, teamId: config.teamId, projectId: config.projectId } as never;
const Q = ["Hey Gomon, what did we decide about rate limits for enterprise tenants?", "Gomon, who owns the billing pipeline?", "Hey Gomon, what's the burst limit?"];
const call = "seed-2026-11-10-globex-sso-kickoff";
const T: Record<string, number[]> = {};
const t = async <X>(name: string, f: () => Promise<X>): Promise<X> => { const t0 = performance.now(); try { return await f(); } finally { (T[name] ??= []).push(Math.round(performance.now() - t0)); } };
await t("atlas ping (cold)", () => db.command({ ping: 1 }));
for (const q of Q) {
  await t("atlas ping", () => db.command({ ping: 1 }));
  await t("calls.findOne", () => c.calls.findOne({ _id: call as never }));
  const mem = await t("retrieve (hybrid memory)", () => retrieve(c, ctx, q));
  const kn = await t("searchKnowledge (3 vector)", () => searchKnowledge(c, ctx, q, "none"));
  await t("workspaceFor", () => workspaceFor(ctx, call));
  await t("templateFor", () => templateFor(c, config.teamId, undefined));
  await t("context in parallel (as fast.ts)", () => Promise.all([retrieve(c, ctx, q), searchKnowledge(c, ctx, q, "none"), workspaceFor(ctx, call), templateFor(c, config.teamId, undefined)]));
  console.log(`  "${q.slice(0, 40)}" memories=${mem.length} knowledge=${kn.length}`);
  const body = { model: config.analyzeModel, max_tokens: 90, thinking: { type: "disabled" }, system: "You are Gomon, an AI teammate in a live call. Answer in one sentence.", messages: [{ role: "user", content: `TEAM MEMORY:\n${mem.map((m) => `- ${m.key}: ${m.text}`).join("\n")}\n\n${q}` }] };
  const H = { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const ans = await t("anthropic full reply", async () => { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: H, body: JSON.stringify(body) }); const j = await r.json() as any; if (!r.ok) throw new Error(JSON.stringify(j)); return j.content.find((b: any) => b.type === "text").text as string; });
  await t("anthropic first token (stream)", async () => { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ ...body, stream: true }) }); const rd = r.body!.getReader(); const d = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done || d.decode(value).includes("content_block_delta")) break; } await rd.cancel(); });
  console.log(`  -> ${ans.slice(0, 110)}`);
  await t(`elevenlabs tts (${process.env.VOICE_MODEL || "eleven_flash_v2_5"})`, () => ttsMp3(ans + " "));
}
console.log("\nSTAGE".padEnd(40), "runs (ms)");
for (const [k, v] of Object.entries(T)) console.log(k.padEnd(39), v.join("  "));
await close();
