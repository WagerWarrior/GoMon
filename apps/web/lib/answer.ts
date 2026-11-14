/**
 * Max (workspace): turn retrieved memories into a spoken-length answer.
 * LLM_PROVIDER=anthropic + LLM_API_KEY -> Claude writes the answer, grounded only on the cited memories.
 * No key (or the call fails) -> retrieval-only answer that quotes the top memory. The demo never breaks on the LLM.
 */
export type Cite = { id: string; key?: string; text: string };
export type Answer = { text: string; by: "llm" | "retrieval"; model?: string; note?: string };

export const DEFAULT_MODEL = "claude-haiku-5-5"; // same as apps/worker ANALYZE_MODEL; spoken answers need speed

export function retrievalAnswer(memory: boolean, cited: Cite[]): Answer {
  if (!memory) return { text: "Memory is off: answering without team context, so no stored decision is checked or cited.", by: "retrieval" };
  return { text: cited.length ? `From team memory: ${cited[0].text}` : "Team memory has nothing on this yet.", by: "retrieval" };
}

export function prompt(question: string, memory: boolean, cited: Cite[]) {
  const system = memory
    ? "You are Gomon, a design-call agent. Answer in at most two short sentences, spoken aloud. Use ONLY the team memories given. If the question conflicts with a memory, say so and cite it by its key (or id). Never invent decisions."
    : "You are Gomon, a design-call agent with team memory turned OFF. Answer in at most two short sentences from general knowledge. Do not claim to know any team decisions.";
  const mem = cited.map((c) => `- [${c.key ?? c.id}] ${c.text}`).join("\n");
  const user = memory ? `Team memories:\n${mem || "(none)"}\n\nQuestion: ${question}` : `Question: ${question}`;
  return { system, user };
}

export async function answer(question: string, memory: boolean, cited: Cite[], env: Record<string, string | undefined> = process.env): Promise<Answer> {
  const fallback = retrievalAnswer(memory, cited);
  if ((env.LLM_PROVIDER || "").toLowerCase() !== "anthropic" || !env.LLM_API_KEY) return fallback;
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const { system, user } = prompt(question, memory, cited);
  try {
    const res = await fetch(`${env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env.LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 200, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await res.json().catch(() => null);
    const text = j?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!res.ok || !text) return { ...fallback, note: `llm unavailable (${res.status}${j?.error?.message ? `: ${j.error.message}` : ""})` };
    return { text, by: "llm", model };
  } catch (e: any) {
    return { ...fallback, note: `llm unavailable (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e})` };
  }
}
