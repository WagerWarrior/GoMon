/**
 * Memory scope. A team's canonical memory lives in two places: company-wide context (customers, production systems,
 * standing policies) under the reserved project id COMPANY_PROJECT, and each project's own decisions under its project id.
 * A call in project P reads both; it writes only to P. Every memory query still filters teamId, projectId and status.
 * Memory keys (D-12, R-04 …) are unique per team, across all projects, so a spoken key always names one memory.
 */
export const COMPANY_PROJECT = "company";

/** projectIds a call in `projectId` may read memory from. */
export function readableProjects(projectId: string): string[] {
  return projectId === COMPANY_PROJECT ? [COMPANY_PROJECT] : [projectId, COMPANY_PROJECT];
}

/** Mongo filter for active memories a call in (teamId, projectId) may read. */
export function memoryFilter(scope: { teamId: string; projectId: string }) {
  return { teamId: scope.teamId, projectId: { $in: readableProjects(scope.projectId) }, status: "active" as const };
}
