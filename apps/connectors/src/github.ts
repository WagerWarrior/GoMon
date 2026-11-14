import { Permanent, Retryable, type Env, type Sent } from "./types";

const MARK = (key: string) => `<!-- gomon-idempotency:${key} -->`;

function cfg(env: Env) {
  if (!env.GITHUB_TOKEN) throw new Permanent("GITHUB_TOKEN is not set");
  if (!env.GITHUB_REPO) throw new Permanent("GITHUB_REPO is not set");
  return { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, base: env.GITHUB_API_URL || "https://api.github.com" };
}
async function call(env: Env, method: string, path: string, body?: unknown) {
  const { token, base } = cfg(env);
  let res: Response;
  try {
    res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "gomon-connectors" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  } catch (e: any) { throw new Retryable(`network error: ${e?.message ?? e}`, method !== "GET"); }
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}
function classify(res: Response, json: any, text: string, what: string): never {
  const msg = `${what}: HTTP ${res.status} ${json?.message ?? text.slice(0, 160)}`;
  const ra = Number(res.headers.get("retry-after"));
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(json?.message ?? ""))) throw new Retryable(msg, false, (ra || 30) * 1000);
  if (res.status >= 500) throw new Retryable(msg, true);   // the server may have applied the write before failing
  throw new Permanent(msg);                                // 401/403/404/422: retrying cannot help
}

/** Look for an issue this action already created (identified by the marker in its body). Used before every retry. */
export async function findIssue(env: Env, key: string): Promise<Sent | null> {
  const { repo } = cfg(env);
  const { res, json, text } = await call(env, "GET", `/repos/${repo}/issues?state=all&labels=gomon&per_page=100&sort=created&direction=desc`);
  if (!res.ok) classify(res, json, text, "list issues");
  const hit = (json as any[]).find((i) => typeof i.body === "string" && i.body.includes(MARK(key)) && !i.pull_request);
  return hit ? { externalId: `${repo}#${hit.number}`, externalUrl: hit.html_url } : null;
}

export async function createIssue(env: Env, payload: Record<string, any>, key: string): Promise<Sent> {
  const { repo } = cfg(env);
  const labels = Array.from(new Set(["gomon", ...(payload.labels ?? [])]));
  const body = { title: String(payload.title ?? "Gomon decision").slice(0, 256), body: `${payload.body ?? ""}\n\n${MARK(key)}`, labels, ...(payload.assignees?.length ? { assignees: payload.assignees } : {}) };
  let r = await call(env, "POST", `/repos/${repo}/issues`, body);
  let note: string | undefined;
  if (r.res.status === 422 && /assignee/i.test(JSON.stringify(r.json))) { // unknown login: file the issue unassigned rather than lose it, and say so
    const { assignees, ...rest } = body as any; r = await call(env, "POST", `/repos/${repo}/issues`, rest); note = "assignee rejected by GitHub; created unassigned";
  }
  if (!r.res.ok) classify(r.res, r.json, r.text, "create issue");
  return { externalId: `${repo}#${r.json.number}`, externalUrl: r.json.html_url, note };
}

/** Read the issue back. A mismatch means the stored external ID does not point at what we meant to create. */
export async function confirmIssue(env: Env, externalId: string, key: string): Promise<boolean> {
  const { repo } = cfg(env); const n = externalId.split("#").pop();
  const { res, json } = await call(env, "GET", `/repos/${repo}/issues/${n}`);
  return res.ok && typeof json?.body === "string" && json.body.includes(MARK(key));
}
