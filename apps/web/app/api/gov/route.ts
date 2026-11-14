import { ObjectId } from "mongodb";
import { callScope, client, db } from "@/lib/db";
import { PolicyDenied, NotFound, correctMemory, enqueueAction, forgetMemory, lockItem, rejectItem } from "@/lib/governance";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Human actions. Same rules as voice: policy check, transaction with audit, outbox for external effects. */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const { op, id, text, actor, callId } = b as { op: string; id?: string; text?: string; actor?: string; callId?: string };
  if (!op || !actor) return Response.json({ error: "op and actor required" }, { status: 400 });
  const c = await client(); const d = await db(); const ctx = { c, d, ...(await callScope(callId)) };
  try {
    switch (op) {
      case "lock": return Response.json(await lockItem(ctx, id!, actor));
      case "reject": return Response.json(await rejectItem(ctx, id!, actor));
      case "correct": if (!text?.trim()) return Response.json({ error: "text required" }, { status: 400 }); return Response.json(await correctMemory(ctx, id!, text.trim(), actor));
      case "forget": return Response.json(await forgetMemory(ctx, id!, actor));
      case "create_issue":
      case "post_slack": {
        if (!callId) return Response.json({ error: "callId required" }, { status: 400 });
        const mems = await d.collection("memories").find({ teamId: ctx.teamId, projectId: ctx.projectId, status: "active", origin: "call", "sourceRefs.callId": callId, ...(id ? { _id: new ObjectId(id) } : {}) }).toArray();
        if (!mems.length) return Response.json({ error: "no locked decisions from this call to send" }, { status: 409 });
        const out = [];
        for (const m of mems) {
          const key = `${m._id}:v${m.version}`; // a corrected memory is a new version and may legitimately be sent again
          const payload = op === "create_issue"
            ? { title: `${m.key ?? m.kind}: ${String(m.text).slice(0, 72)}`, body: `${m.text}\n\nLocked on call \`${callId}\` by ${m.lock?.participants?.join(", ") ?? "the team"}.\nMemory \`${m._id}\` v${m.version} (${m.key ?? m.kind}).`, labels: ["gomon", String(m.kind)] }
            : { text: `Decision locked (${m.key ?? m.kind}): ${m.text}`, callId, memoryId: String(m._id) }; // same payloads as apps/worker enqueueForCall
          out.push(await enqueueAction(ctx, op, payload, actor, callId, key));
        }
        return Response.json({ queued: out });
      }
      default: return Response.json({ error: "unknown op" }, { status: 400 });
    }
  } catch (e: any) {
    if (e instanceof PolicyDenied) return Response.json({ error: "policy_denied", reason: e.result.reason }, { status: 403 });
    if (e instanceof NotFound) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ error: String(e?.message ?? e) }, { status: 409 });
  }
}
