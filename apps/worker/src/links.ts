/**
 * Integrations Gomon can use mid-call: find the right link (GitHub issue for a decision, the repo, the Slack post, or a GitHub
 * search) and drop it in the meeting chat through Recall. Every shared link is also stored in `chat_messages` so the workspace
 * can show it.
 */
import type { Ctx } from "./governance.ts";
import type { Retrieved } from "./retrieve.ts";

export type Link = { url: string; label: string; source: "action" | "repo" | "github_search" };

const env = {
  recallKey: () => process.env.RECALL_API_KEY ?? "",
  recallRegion: () => process.env.RECALL_REGION || "us-west-2",
  githubToken: () => process.env.GITHUB_TOKEN ?? "",
  githubRepo: () => process.env.GITHUB_REPO || "WagerWarrior/MongoDB",
};

type ActionDoc = { type: string; externalUrl?: string; payload?: { title?: string }; memoryId?: unknown };

export async function resolveLink(ctx: Ctx, callId: string, memory: Retrieved | null, query: string): Promise<Link | null> {
  const q = query.toLowerCase();
  const wantsSlack = /slack|thread|channel/.test(q);
  const typeOrder = wantsSlack ? ["post_slack", "create_issue", "github"] : ["create_issue", "github", "post_slack"];
  const pick = (docs: ActionDoc[]) => typeOrder.map((t) => docs.find((d) => d.type === t && d.externalUrl)).find(Boolean);

  if (memory) {
    const hit = pick(await ctx.c.actions.find<ActionDoc>({ teamId: ctx.teamId, memoryId: memory._id, externalUrl: { $type: "string" } }).sort({ _id: -1 }).toArray());
    if (hit?.externalUrl) return { url: hit.externalUrl, label: `${memory.key ?? "Decision"} ${hit.type === "post_slack" ? "in Slack" : "on GitHub"}`, source: "action" };
  }
  if (/\brepo(sitory)?\b|codebase|source/.test(q)) return { url: `https://github.com/${env.githubRepo()}`, label: "The repo", source: "repo" };

  const token = env.githubToken();
  if (token && query.trim() && !wantsSlack) {
    const res = await fetch(`https://api.github.com/search/issues?per_page=1&q=${encodeURIComponent(`repo:${env.githubRepo()} ${query}`)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { items?: { html_url: string; title: string; number: number }[] };
      const it = body.items?.[0];
      if (it) return { url: it.html_url, label: `#${it.number} ${it.title}`, source: "github_search" };
    }
  }
  const recent = pick(await ctx.c.actions.find<ActionDoc>({ teamId: ctx.teamId, callId, externalUrl: { $type: "string" } }).sort({ _id: -1 }).limit(20).toArray());
  if (recent?.externalUrl) return { url: recent.externalUrl, label: recent.payload?.title ?? "Latest from this call", source: "action" };
  // Nothing specific: the repo's open issues are still a useful link to drop.
  return { url: `https://github.com/${env.githubRepo()}/issues`, label: "Open GitHub issues", source: "repo" };
}

/** Post to the meeting chat via the call's Recall bot (Meet limit: 500 chars). Returns whether Recall accepted it. */
export async function postToMeetingChat(ctx: Ctx, callId: string, message: string, link?: Link): Promise<boolean> {
  const call = await ctx.c.calls.findOne({ _id: callId as never }, { projection: { botId: 1 } });
  const botId = typeof call?.botId === "string" ? call.botId : "";
  let status: "sent" | "failed" | "no_bot" = "no_bot";
  let error: string | undefined;
  if (botId && env.recallKey()) {
    const res = await fetch(`https://${env.recallRegion()}.recall.ai/api/v1/bot/${botId}/send_chat_message/`, {
      method: "POST",
      headers: { authorization: `Token ${env.recallKey()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ to: "everyone", message: message.slice(0, 500) }),
    });
    status = res.ok ? "sent" : "failed";
    if (!res.ok) error = `Recall ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  await ctx.c.chatMessages.insertOne({
    callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), message, status, botId: botId || undefined,
    ...(link ? { url: link.url, label: link.label, source: link.source } : {}), ...(error ? { error } : {}),
  });
  return status === "sent";
}
