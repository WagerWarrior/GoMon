import type { Db } from "mongodb";

export type PolicyResult = { allowed: boolean; reason: string; policyId?: string; checkedAt: Date };

/**
 * Same rule as apps/web/lib/governance.ts (spec section 6): default-deny, role from members, rule from policies.
 * Kept as a small copy so the worker has no dependency on the Next app; both are covered by tests.
 */
export async function checkPolicy(d: Db, teamId: string, projectId: string, actor: string, action: string): Promise<PolicyResult> {
  const checkedAt = new Date();
  const member = await d.collection("members").findOne({ teamId, displayName: actor });
  if (!member) return { allowed: false, reason: `unknown member "${actor}"`, checkedAt };
  const policy = await d.collection("policies").findOne({ teamId, action, $or: [{ projectId }, { projectId: { $exists: false } }] });
  if (!policy) return { allowed: false, reason: `no policy for ${action}`, checkedAt };
  const ok = (policy.allowedRoles as string[]).includes(member.role as string);
  return { allowed: ok, reason: ok ? `role ${member.role} may ${action}` : `role ${member.role} may not ${action}`, policyId: String(policy._id), checkedAt };
}
