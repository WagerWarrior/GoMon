/** Runtime configuration. Secrets come from the repo-root `.env` (never committed). */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (set it in the repo-root .env)`);
  return v;
}

export const config = {
  mongoUri: () => req("MONGODB_URI"),
  dbName: process.env.MONGODB_DB || "gomon",
  teamId: process.env.TEAM_ID || "northwind-platform",
  projectId: process.env.PROJECT_ID || "public-api-launch",
  /** Atlas Automated Embedding model (server-side Voyage); used by the memories_auto index at index and query time. */
  embedModel: process.env.EMBED_MODEL || "voyage-4",
  llmKey: () => req("LLM_API_KEY"),
  analyzeModel: process.env.ANALYZE_MODEL || "claude-haiku-5-5",
  port: Number(process.env.WORKER_PORT || 3001),
  workerToken: process.env.WORKER_TOKEN || "",
  /** Veto window after Gomon announces "Locking in: …". */
  vetoMs: Number(process.env.VETO_MS || 10_000),
  /** Unpromoted call items expire after this long (TTL index on expiresAt). */
  scratchTtlMs: Number(process.env.SCRATCH_TTL_MS || 6 * 3600_000),
  /** Proactive alternative suggestions are rate-limited to one per window. */
  suggestionWindowMs: Number(process.env.SUGGESTION_WINDOW_MS || 5 * 60_000),
  /** Do not repeat the same conflict out loud within this window. */
  conflictRepeatMs: Number(process.env.CONFLICT_REPEAT_MS || 3 * 60_000),
  agentName: process.env.AGENT_NAME || "Gomon",
};

export const INDEX = { vector: "memories_auto", text: "memories_text" } as const;
