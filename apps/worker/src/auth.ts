/**
 * Users and sessions in Atlas. Passwords are scrypt-hashed; session tokens are random and stored only as a SHA-256 hash in
 * `user_sessions`, which a TTL index expires. A user sees the calls they own or spoke in (`calls.ownerUserId`,
 * `calls.participantUserIds`, filled from meeting display names).
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Document } from "mongodb";
import type { Cols } from "./db.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_TTL_MS = 12 * 3600_000;

export type PublicUser = { _id: string; email: string; name: string; teamId: string; role: string; displayNames: string[] };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(pw, salt, 32)).toString("base64")}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const got = await scrypt(pw, Buffer.from(salt, "base64"), 32);
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function publicUser(u: Document): PublicUser {
  return { _id: String(u._id), email: String(u.email), name: String(u.name), teamId: String(u.teamId), role: String(u.role), displayNames: (u.displayNames as string[]) ?? [] };
}

export async function login(c: Cols, email: string, password: string): Promise<{ token: string; user: PublicUser } | null> {
  const u = await c.users.findOne({ email: email.trim().toLowerCase() });
  if (!u || typeof u.passwordHash !== "string" || !(await verifyPassword(password, u.passwordHash))) return null;
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await c.userSessions.insertOne({ _id: tokenHash(token) as never, userId: u._id, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  await c.users.updateOne({ _id: u._id }, { $set: { lastLoginAt: now } });
  return { token, user: publicUser(u) };
}

export async function logout(c: Cols, token: string): Promise<void> {
  await c.userSessions.deleteOne({ _id: tokenHash(token) as never });
}

/** Resolves a session token; TTL deletion is approximate, so expiry is also checked here. */
export async function userFromToken(c: Cols, token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;
  const s = await c.userSessions.findOne({ _id: tokenHash(token) as never });
  if (!s || !(s.expiresAt instanceof Date) || s.expiresAt.getTime() < Date.now()) return null;
  const u = await c.users.findOne({ _id: s.userId });
  return u ? publicUser(u) : null;
}

/** The filter for "calls this user may see". Use the same rule in the workspace. */
export function visibleCallsFilter(user: PublicUser): Document {
  return { teamId: user.teamId, $or: [{ ownerUserId: user._id }, { participantUserIds: user._id }] };
}

/** Map a meeting display name ("Tamir Azbel") to a user id, case-insensitively. */
export async function userIdForDisplayName(c: Cols, teamId: string, displayName: string): Promise<string | null> {
  const u = await c.users.findOne({ teamId, displayNamesLower: displayName.trim().toLowerCase() }, { projection: { _id: 1 } });
  return u ? String(u._id) : null;
}
