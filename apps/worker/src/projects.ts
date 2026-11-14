/**
 * Gomon projects (`projects`, contract 3): a working scope for calls and memory. Created by voice ("start a new project called
 * Usage billing") or the workspace; both go through the `create_project` policy and write the project with its audit row in one
 * transaction. The GitHub board is an external effect, so it is only ever an outbox action.
 */
import { MongoServerError, type Collection } from "mongodb";
import { audit, enqueueGithub, gate, type Ctx } from "./governance.ts";
import { COMPANY_PROJECT } from "./scope.ts";
import type { Project } from "./shapes.ts";

export type CreateProjectInput = { name: string; description?: string; actor: string; callId?: string };
export type CreatedProject = { _id: string; name: string; created: boolean };

/** "Usage billing!" -> "usage-billing". */
export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Active project of this team by spoken name or slug (case-insensitive), or null. */
export async function findProject(ctx: Ctx, name: string): Promise<Project | null> {
  const n = name.trim();
  if (!n) return null;
  const projects = ctx.c.projects as unknown as Collection<Project>;
  return projects.findOne({
    teamId: ctx.teamId, status: "active", _id: { $ne: COMPANY_PROJECT },
    $or: [{ name: { $regex: `^${escape(n)}$`, $options: "i" } }, { _id: slugify(n) }],
  });
}

/**
 * Policy `create_project` (denial audited, throws PolicyDenied), then reuse an active project with the same name, else insert
 * the project under a free slug (`usage-billing`, `usage-billing-2` …; `_id` is global, "company" is reserved) and its
 * `project_created` audit row in one transaction.
 */
export async function createProject(ctx: Ctx, input: CreateProjectInput): Promise<CreatedProject> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new Error("project name is required");
  await gate(ctx, input.actor, "create_project", input.callId, { name });
  const existing = await findProject(ctx, name);
  if (existing && existing.name.toLowerCase() === name.toLowerCase()) return { _id: existing._id, name: existing.name, created: false };

  const base = slugify(name);
  for (let i = 1; i <= 20; i++) {
    const _id = i === 1 && base !== COMPANY_PROJECT ? base : `${base}-${i === 1 ? 2 : i}`;
    if (await ctx.c.projects.findOne({ _id: _id as never }, { projection: { _id: 1 } })) continue;
    const now = new Date();
    const doc: Project = { _id, teamId: ctx.teamId, name, ...(input.description ? { description: input.description } : {}), status: "active", createdAt: now, createdBy: input.actor };
    try {
      await ctx.client.withSession((session) => session.withTransaction(async () => {
        await ctx.c.projects.insertOne(doc as never, { session });
        await audit({ ...ctx, projectId: _id }, { callId: input.callId, type: "project_created", actor: input.actor, reason: `project "${name}"`, ref: { projectId: _id } }, session);
      }));
      return { _id, name, created: true };
    } catch (e) {
      if (!(e instanceof MongoServerError && e.code === 11000)) throw e;
      const raced = await findProject(ctx, name); // someone created it (or took the slug) a moment ago
      if (raced && raced.name.toLowerCase() === name.toLowerCase()) return { _id: raced._id, name: raced.name, created: false };
    }
  }
  throw new Error(`no free project id for "${name}"`);
}

/**
 * createProject plus its GitHub Projects board (contract 6 `create_project`), when GitHub is configured and the project has no
 * board yet. The key `github:project:<id>:create_project` makes the board request once per project, however often it is asked.
 */
export async function createProjectWithBoard(ctx: Ctx, input: CreateProjectInput): Promise<CreatedProject & { boardQueued: boolean }> {
  const p = await createProject(ctx, input);
  const hasBoard = !!(await ctx.c.projects.findOne({ _id: p._id as never, "github.projectId": { $type: "string" } }, { projection: { _id: 1 } }));
  if (hasBoard || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return { ...p, boardQueued: false };
  const boardQueued = await enqueueGithub(
    { ...ctx, projectId: p._id }, input.callId, input.actor, "create_project",
    { project: p._id, title: p.name, ...(input.description ? { description: input.description } : {}) },
    `github:project:${p._id}:create_project`,
  );
  return { ...p, boardQueued };
}
