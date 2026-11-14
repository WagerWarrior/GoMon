import { Permanent, Retryable, type Env, type Sent } from "./types";

const PERMANENT = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "channel_not_found", "not_in_channel", "is_archived", "missing_scope", "msg_too_long", "no_text", "invalid_arguments", "restricted_action"]);

function cfg(env: Env) {
  if (!env.SLACK_BOT_TOKEN) throw new Permanent("SLACK_BOT_TOKEN is not set");
  if (!env.SLACK_CHANNEL_ID) throw new Permanent("SLACK_CHANNEL_ID is not set");
  return { token: env.SLACK_BOT_TOKEN, channel: env.SLACK_CHANNEL_ID, base: env.SLACK_API_URL || "https://slack.com/api" };
}
async function api(env: Env, method: string, body: Record<string, unknown>, mutating: boolean) {
  const { token, base } = cfg(env);
  let res: Response;
  try {
    res = await fetch(`${base}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  } catch (e: any) { throw new Retryable(`network error: ${e?.message ?? e}`, mutating); }
  if (res.status === 429) throw new Retryable("slack rate limited", false, (Number(res.headers.get("retry-after")) || 30) * 1000);
  if (res.status >= 500) throw new Retryable(`slack HTTP ${res.status}`, mutating);
  const json: any = await res.json().catch(() => null);
  if (!json?.ok) {
    const err = json?.error ?? "unknown_error";
    if (err === "ratelimited") throw new Retryable("slack rate limited", false, 30000);
    if (PERMANENT.has(err)) throw new Permanent(`slack ${method}: ${err}`);
    throw new Retryable(`slack ${method}: ${err}`, mutating);
  }
  return json;
}
const META = (key: string) => ({ event_type: "gomon_action", event_payload: { idempotencyKey: key } });

/** Find a message this action already posted (Slack has no idempotency key; we tag messages with metadata and look back). */
export async function findMessage(env: Env, key: string, threadTs?: string): Promise<Sent | null> {
  const { channel } = cfg(env);
  const json = threadTs
    ? await api(env, "conversations.replies", { channel, ts: threadTs, limit: 100, include_all_metadata: true }, false)
    : await api(env, "conversations.history", { channel, limit: 100, include_all_metadata: true }, false);
  const hit = (json.messages as any[]).find((m) => m.metadata?.event_payload?.idempotencyKey === key);
  return hit ? { externalId: `${channel}:${hit.ts}` } : null;
}

export async function postMessage(env: Env, text: string, key: string, threadTs?: string): Promise<Sent & { ts: string }> {
  const { channel } = cfg(env);
  const json = await api(env, "chat.postMessage", { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), metadata: META(key), unfurl_links: false }, true);
  return { externalId: `${json.channel ?? channel}:${json.ts}`, ts: json.ts };
}
