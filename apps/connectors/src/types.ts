export type Action = {
  _id: any; callId?: string; teamId: string; projectId: string; type: "create_issue" | "post_slack" | "github";
  payload: Record<string, any>; requestedBy: string; status: string; idempotencyKey: string; attempts?: number;
  externalId?: string; externalUrl?: string; nextAttemptAt?: Date; updatedAt?: Date;
};
export type Env = {
  GITHUB_TOKEN?: string; GITHUB_REPO?: string; GITHUB_API_URL?: string;
  SLACK_BOT_TOKEN?: string; SLACK_CHANNEL_ID?: string; SLACK_API_URL?: string;
};
/** Thrown for failures worth retrying (network, 5xx, rate limit). `ambiguous` = the request may have been applied. */
export class Retryable extends Error { constructor(msg: string, public ambiguous = false, public retryAfterMs?: number) { super(msg); } }
/** Thrown for failures that retrying cannot fix (bad token, missing channel, validation). */
export class Permanent extends Error {}
export type Sent = { externalId: string; externalUrl?: string; note?: string };
