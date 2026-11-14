/**
 * Links sent from the dashboard into the meeting chat (web POST /api/sessions/:id/share writes a `chat_messages` row with
 * status "requested"). This worker holds the Recall key, so it posts the message through the call's bot and records the
 * outcome on the same row. Rows older than two minutes are left alone: a link nobody saw arrive is not posted late.
 */
import type { Cols } from "./db.ts";
import { config } from "./config.ts";

const MAX_AGE_MS = 120_000;

async function post(c: Cols, row: { _id?: unknown }): Promise<void> {
  // Claim it, so two workers (or the stream and the sweep) never post the same link twice.
  const claimed = await c.chatMessages.findOneAndUpdate({ _id: row._id as never, status: "requested" }, { $set: { status: "sending" } });
  if (!claimed) return;
  const call = await c.calls.findOne({ _id: String(claimed.callId) as never }, { projection: { botId: 1 } });
  const botId = typeof call?.botId === "string" ? call.botId : "";
  let status = "no_bot"; let error: string | undefined;
  if (botId && config.recall.apiKey) {
    const res = await fetch(`https://${config.recall.region}.recall.ai/api/v1/bot/${botId}/send_chat_message/`, {
      method: "POST",
      headers: { authorization: `Token ${config.recall.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ to: "everyone", message: String(claimed.message ?? "").slice(0, 500) }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    status = res?.ok ? "sent" : "failed";
    if (!res?.ok) error = `Recall ${res?.status ?? "unreachable"}`;
  }
  await c.chatMessages.updateOne({ _id: claimed._id }, { $set: { status, sentAt: new Date(), ...(error ? { error } : {}) } });
  console.log(`[chat] ${String(claimed.callId)} link ${status}`);
}

export function watchChatRequests(c: Cols): void {
  const fresh = () => ({ status: "requested", teamId: config.teamId, at: { $gte: new Date(Date.now() - MAX_AGE_MS) } });
  const sweep = () => c.chatMessages.find(fresh()).limit(10).forEach((row) => { void post(c, row).catch((e) => console.error("[chat]", e)); }).catch((e) => console.error("[chat]", e));
  const cs = c.chatMessages.watch([{ $match: { operationType: "insert", "fullDocument.status": "requested", "fullDocument.teamId": config.teamId } }]);
  cs.on("change", (ev) => { if (ev.operationType === "insert") void post(c, ev.fullDocument).catch((e) => console.error("[chat]", e)); });
  cs.on("error", (e) => console.warn("[chat] stream error:", e.message));
  // The stream can miss a row while it reconnects; a slow sweep catches it inside the two-minute window.
  setInterval(() => { void sweep(); }, 10_000);
  void sweep();
}
