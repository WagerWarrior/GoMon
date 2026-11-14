/**
 * Workspace-side types for the collections in spec.md section 6 (Max's read/write surface).
 * Rob owns the Atlas schema; when packages/shared lands, replace these with imports from it.
 * Fields beyond the spec's table are optional so a teammate's richer documents still render.
 */
export type ObjectIdLike = { toString(): string };

export interface Utterance {
  _id: ObjectIdLike | string; callId: string; seq: number; speaker: { displayName: string };
  text: string; source?: string; startedAt?: Date | string; endedAt?: Date | string; synthetic?: boolean;
}
export type ItemKind = "decision" | "requirement" | "constraint" | "risk" | "open_question" | "action" | "assumption" | "interface" | "alternative";
export type ItemStatus = "proposed" | "locking" | "promoted" | "rejected";
export interface CallItem {
  _id: ObjectIdLike | string; callId: string; kind: ItemKind; text: string; status: ItemStatus;
  sourceUtteranceIds?: (ObjectIdLike | string)[]; expiresAt?: Date | string | null;
  lockAnnouncedAt?: Date | string | null; vetoMs?: number; synthetic?: boolean;
}
export type MemoryStatus = "active" | "superseded" | "forgotten";
export interface Memory {
  _id: ObjectIdLike | string; teamId: string; projectId: string; kind: ItemKind; text: string;
  status: MemoryStatus; version: number; supersedes?: ObjectIdLike | string | null; supersededBy?: ObjectIdLike | string | null;
  key?: string; // human id such as D-09 / R-12 when the memory has one
  origin?: "call" | "doc"; sourceRefs?: unknown[]; lock?: { lockedAt?: Date | string; participants?: string[]; lockedBy?: string; via?: string };
  forgottenAt?: Date | string; forgottenBy?: string; synthetic?: boolean;
}
export interface Conflict {
  _id: ObjectIdLike | string; callId: string; itemId?: ObjectIdLike | string; memoryId?: ObjectIdLike | string;
  memoryKey?: string; severity: "low" | "medium" | "high"; spoken?: boolean; note?: string; createdAt?: Date | string;
}
/** `github` actions carry `payload.op` (create_issue | update_issue | create_project | add_to_project | create_milestone). */
export type ActionType = "create_issue" | "post_slack" | "github";
export type ActionStatus = "queued" | "sending" | "sent" | "confirmed" | "denied" | "failed" | "needs_review";
export interface ActionDoc {
  _id: ObjectIdLike | string; callId?: string; teamId: string; projectId: string; type: ActionType;
  payload: Record<string, unknown>; requestedBy: string; policyCheck?: { allowed: boolean; reason?: string; policyId?: string; checkedAt?: Date | string };
  status: ActionStatus; idempotencyKey: string; externalId?: string; externalUrl?: string; error?: string; attempts?: number;
  createdAt: Date | string; updatedAt?: Date | string;
}
export interface AuditEvent {
  _id: ObjectIdLike | string; callId?: string; teamId?: string; projectId?: string; at: Date | string;
  type: string; actor: string; reason?: string; ref?: Record<string, unknown>;
}
export interface TimingDoc { _id: ObjectIdLike | string; callId: string; stage: string; ms: number; at?: Date | string }
export interface CallDoc {
  _id: ObjectIdLike | string; teamId: string; projectId: string; title?: string; status?: string;
  participants?: string[]; meetingUrl?: string; slackThreadTs?: string; synthetic?: boolean; startedAt?: Date | string;
  botId?: string; endedAt?: Date | string; ownerUserId?: string;
}
export interface Member { _id: ObjectIdLike | string; teamId: string; displayName: string; role: string }
export interface PolicyDoc { _id: ObjectIdLike | string; teamId: string; projectId?: string; action: string; allowedRoles: string[] }
/** `projects`: `_id` is a slug; the reserved `company` project holds company-wide context every call reads. */
export interface ProjectDoc {
  _id: string; teamId: string; name: string; description?: string; status: "active" | "archived"; createdAt?: Date | string; createdBy?: string;
  github?: { projectNumber?: number; projectId?: string; url?: string }; synthetic?: boolean;
}
